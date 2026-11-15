import { afterEach, assert, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../../auto-reply/reply/get-reply.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { bindReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { updateRpcSourceSessionId } from "../../sessions/session-controller.rpc-sources.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { prepareTalkClientControlAuthority } from "./client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./client-tool-authority.js";
import { resolveOwnedActiveTalkRunTarget } from "./run-ownership.js";
import { prepareTalkSessionTarget } from "./session-target.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

afterEach(() => {
  vi.mocked(runEmbeddedAgent).mockReset();
  testing.resetActiveEmbeddedRuns();
  vi.restoreAllMocks();
});

function clientAuthority(client: ReturnType<typeof sharingPolicyClient>) {
  return {
    ...resolveTalkAgentConsultAuthority(client.connect.scopes, client),
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "talk-requester",
      scopes: client.connect.scopes ?? [],
      assertCurrent: () => {},
    }),
  };
}

// Normal reply preparation, not a fabricated FollowupRun/hash, supplies this baseline.
it.each([true, false])(
  "steers a GA chat-owned Talk run captured before backend publication=%s",
  async (beforePublication) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = withFullRuntimeReplyConfig({
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            skipBootstrap: true,
            model: { primary: "mock-openai/gpt-5.6-luna" },
            models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
          },
        },
        plugins: { enabled: false },
      });
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const client = sharingPolicyClient({
        user: "talk-requester",
        deviceId: "caller-device",
        scopes: ["operator.admin"],
      });
      client.connect.caps = ["tool-events", "task-suggestions"];
      const sessionTarget = await prepareTalkSessionTarget(config, "agent:main:main");
      const authority = clientAuthority(client);
      const runId = "talk-authority-run";
      const registration = registerChatAbortController({
        runId,
        sessionId: "queued-session",
        sessionKey: sessionTarget.canonicalKey,
        agentId: sessionTarget.agentId,
        ownerConnId: "talk-authority-client",
        target: captureSessionTarget({
          storeScope: sessionTarget.storePath,
          sessionKey: sessionTarget.canonicalKey,
          agentId: sessionTarget.agentId,
        }),
        timeoutMs: 60_000,
        kind: "chat-send",
      });
      assert(registration.registered, "Missing Gateway run registration");
      const queueMessage = vi.fn(async () => undefined);
      const reply = { text: "Original GA task completed." };
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
        const {
          preparedRunAdmission,
          replyOperation: operation,
          provider,
          model: modelId,
          sessionFile,
        } = params;
        assert(
          preparedRunAdmission && operation && provider && modelId && sessionFile,
          "Missing real reply admission",
        );
        updateRpcSourceSessionId(registration.entry, params.sessionId);
        const admittedRunContext = await preparedRunAdmission.admit("embedded", "talk-chat-test");
        return await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...params, provider, modelId, sessionFile },
          undefined,
          async (prepared) => {
            const handle = {
              ...createEmbeddedRunHandle({
                runId: params.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                queueMessage,
              }),
              messageInjectionV2: {
                version: 2,
                isAvailable: () => true,
                queueMessage: async (_text, _options, assertCurrent) => {
                  assertCurrent();
                  await queueMessage();
                },
              },
              kind: "embedded" as const,
              cancel: () => {},
            } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
            const captureTarget = () =>
              resolveOwnedActiveTalkRunTarget({
                clientConnId: "talk-authority-client",
                sessionTarget,
                scope: { kind: "session" },
              });
            const queuedTarget = beforePublication ? captureTarget() : undefined;
            operation.attachBackend(handle);
            operation.setPhase("running");
            expect(registration.entry.input.claim?.operation).toBe(operation);
            setActiveEmbeddedRun(
              params.sessionId,
              handle,
              params.sessionKey,
              params.sessionFile,
              params.agentId,
              operation,
            );
            const runTarget = beforePublication ? queuedTarget : captureTarget();
            expect(runTarget?.isCurrent(params.sessionId)).toBe(true);
            const steer = (source: "reply" | "attempt" | undefined, current = authority) =>
              controlRealtimeVoiceAgentRun({
                sessionKey: sessionTarget.canonicalKey,
                runTarget,
                text: "use the release branch",
                getToolAuthorityOverlay: () => {
                  const overlay = prepareTalkClientControlAuthority({
                    config,
                    sessionTarget,
                    authority: current,
                    source,
                    agentRuntime: createPluginRuntime().agent,
                  });
                  if (source !== "reply") {
                    expect(overlay.traceAuthorized).toBe(false);
                  }
                  return overlay;
                },
              });
            try {
              // This is the old direct-voice overlay; it truthfully lacks GA trace/reviewer/client facts.
              await expect(steer("attempt")).resolves.toMatchObject({
                queued: false,
                reason: "tool_authority_mismatch",
              });
              await expect(steer(runTarget?.toolAuthoritySource)).resolves.toMatchObject({
                queued: true,
              });
              const weaker = sharingPolicyClient({
                user: "talk-requester",
                deviceId: "caller-device",
                scopes: ["operator.read"],
              });
              await expect(
                steer(runTarget?.toolAuthoritySource, clientAuthority(weaker)),
              ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
              expect(queueMessage).toHaveBeenCalledOnce();
            } finally {
              clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
            }
            return { payloads: [reply], meta: { durationMs: 1 } };
          },
        );
      });
      const result = await getReplyFromConfig(
        finalizeInboundContext({
          ...authority.replyCaller,
          AgentId: "main",
          SessionKey: sessionTarget.canonicalKey,
          Body: "Check the repository",
          BodyForAgent: "Check the repository",
          CommandAuthorized: false,
          CommandInterpretationSuppressed: true,
          InputProvenance: { kind: "internal_system", sourceTool: "openclaw_agent_consult" },
        }),
        {
          toolsAllow: authority.toolsAllow,
          operatorAuthority: authority.operatorAuthority,
          turnAdoptionLifecycle: bindReplySourceInput(
            { onAdopted: () => {} },
            registration.entry.input,
          ),
          runId,
          abortSignal: registration.controller.signal,
        },
        config,
      ).finally(registration.cleanup);
      // Reply recovery may consume backend failures; still surface every assertion above.
      await vi.mocked(runEmbeddedAgent).mock.results[0]?.value;
      expect([result].flat()).toContainEqual(expect.objectContaining(reply));
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  },
);
