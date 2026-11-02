import { afterEach, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { sanitizeAgentRunTerminalReply } from "../agent-run-terminal-reply.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import { readFollowupRequest } from "../subagents/completion/session-followup-completion.js";
import type { FollowupCompletionOwner } from "../subagents/completion/session-followup-completion.types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const inference = vi.hoisted(() =>
  vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
);
// mock-isolation: Only harness/model execution is synthetic; Gateway admission, custody, profiles and sessions stay real.
vi.mock("../../commands/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agent.js")>()),
  agentCommandFromGatewayIngress: inference,
}));

afterEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["allowed", "revoked", "replaced"] as const)(
  "admits a delayed ACP result only under current parent custody: %s",
  async (boundary) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: state.workspaceDir } },
            defaults: { model: { primary: "fixture/model" } },
          },
          models: {
            providers: {
              fixture: {
                baseUrl: "http://127.0.0.1:9/v1",
                api: "openai-completions",
                apiKey: "synthetic-acp-custody",
                models: [
                  {
                    id: "model",
                    name: "Fixture",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
          plugins: { enabled: false },
          tools: { sessions: { visibility: "all" } },
          session: { communication: { send: "always", receive: "always" } },
          gateway: {
            roles: {
              default: "write",
              definitions: {
                write: {
                  agents: "*",
                  scopes: ["operator.read", "operator.write"],
                  sessions: { others: "write" },
                },
              },
            },
          },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await refreshPreparedModelRuntimeSnapshots(cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
        });
        const parentKey = "agent:main:dashboard:acp-custody-parent";
        const childKey = "agent:main:acp:completed-custody-child";
        const parent = {
          sessionId: "parent-session",
          lifecycleRevision: "parent-v1",
          updatedAt: 1,
        };
        await replaceSessionEntry({ agentId: "main", sessionKey: parentKey }, parent);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: childKey },
          {
            sessionId: "child-session",
            lifecycleRevision: "child-v1",
            updatedAt: 1,
            spawnedBy: parentKey,
            parentSessionId: parent.sessionId,
          },
        );
        await upsertAcpSessionMeta({
          cfg,
          agentId: "main",
          sessionKey: childKey,
          mutate: () => ({
            backend: "acpx",
            agent: "fixture",
            runtimeSessionName: "completed-child",
            mode: "oneshot",
            state: "idle",
            lastActivityAt: 1,
          }),
        });
        const work = new AsyncWorkScope();
        const context = createContext([], () => cfg);
        Object.assign(context, createAgentTurnTestContext(), {
          getRuntimeConfig: () => cfg,
          trackExecution: <T>(run: () => T | Promise<T>) => work.track(run),
        });
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const projection = await createSessionRowProjection({ cfg, context, modelCatalog: [] });
        bindSessionRowProjection(context, () => projection);
        const client = createOperatorClient({
          profileName: "acp-custody-parent",
          scopes: ["operator.read", "operator.write"],
        });
        const device = captureGatewayDeviceRevocation(
          context,
          { deviceId: "acp-custody-device", role: "operator" },
          () => true,
          undefined,
          { isCurrent: () => true, subscribe: () => () => {} },
        );
        const source = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: device.isCurrent,
        });
        const origin = captureRequesterOrigin({
          sessionKey: parentKey,
          operatorProfileId: client.authenticatedUserProfile?.profileId,
        });
        if (!source || !origin) {
          throw new Error("Expected parent operator authority");
        }
        const childStarted = createDeferredCore();
        const releaseChild = createDeferredCore();
        const finished = createDeferredCore();
        const admissions: string[] = [];
        let completion: FollowupCompletionOwner | undefined;
        let invocationOpen = true;
        const resultText = "Synthetic completed ACP follow-up result";
        inference.mockImplementation(async (options) => {
          options.abortSignal?.throwIfAborted();
          if (options.sessionKey === childKey) {
            const request = readFollowupRequest(options.runId ?? "", childKey);
            completion = request?.completion;
            if (!completion) {
              throw new Error("ACP follow-up has no production completion custody");
            }
            completion.signal.addEventListener("abort", () => finished.resolve(), { once: true });
            childStarted.resolve();
            await releaseChild.promise;
          } else {
            expect(options.sessionKey).toBe(parentKey);
            admissions.push(options.message ?? "");
          }
          return {
            payloads: [{ text: resultText, mediaUrl: null }],
            meta: { durationMs: 0, terminalReply: sanitizeAgentRunTerminalReply(resultText) },
          };
        });
        try {
          const sent = await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext,
              hasCurrentClientAuthority: device.isCurrent,
              isWebchatConnect: () => false,
            },
            () =>
              withOperatorToolGatewayAuthority({ scopes: client.connect.scopes ?? [] }, () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: parentKey,
                    requesterOrigin: origin,
                    operatorAuthority: source.authority,
                    operationalRunInstance:
                      createOperationalRunInstanceRef("acp-custody-invocation"),
                    receiptAuthority: () => invocationOpen,
                  },
                  () =>
                    createSessionsSendTool({
                      config: cfg,
                      agentId: "main",
                      agentSessionKey: parentKey,
                    }).execute("acp-followup", {
                      sessionKey: childKey,
                      message: "Continue the completed run",
                      timeoutSeconds: 0,
                    }),
                ),
              ),
          );
          expect(sent.details, JSON.stringify(sent.details)).toMatchObject({
            status: "accepted",
            delivery: { status: "pending" },
          });
          await childStarted.promise;
          invocationOpen = false;
          source.release();
          device.release();
          if (boundary === "revoked") {
            invalidateGatewayDeviceRevocation(context, "acp-custody-device", "operator");
          } else if (boundary === "replaced") {
            await replaceSessionEntry(
              { agentId: "main", sessionKey: parentKey },
              { ...parent, lifecycleRevision: "parent-v2" },
            );
          }
          releaseChild.resolve();
          await finished.promise;
          await work.drain();
          if (boundary === "allowed") {
            expect(admissions).toEqual([expect.stringContaining(resultText)]);
          } else {
            expect(admissions).toEqual([]);
          }
        } finally {
          releaseChild.resolve();
          completion?.close();
          await work.drain();
          source.release();
          device.release();
          projection.dispose();
          await resetPreparedModelRuntimeSnapshotsForTest();
        }
      },
    );
  },
);
