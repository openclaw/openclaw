import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { prepareAgentCommandExecutionIdentity } from "../agents/agent-command-execution-identity.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { agentCommandMock, testState } from "./test-helpers.js";

export const sessionSendAuthorityCases = [
  { mode: "allowed", denyWrite: false, cancelSignal: undefined },
  { mode: "denied", denyWrite: true, cancelSignal: undefined },
  { mode: "run-cancelled", denyWrite: false, cancelSignal: "run" },
  { mode: "request-cancelled", denyWrite: false, cancelSignal: "execute" },
] as const;

type SessionSendAuthorityCase = (typeof sessionSendAuthorityCases)[number];

export async function emitLifecycleAssistantReply(
  opts: AgentCommandGatewayIngressOpts,
  text = "ANNOUNCE_SKIP",
): Promise<void> {
  const sessionId = opts.sessionId ?? "main";
  const runId = opts.runId ?? sessionId;
  if (!opts.sessionKey) {
    throw new Error("expected session key for lifecycle reply");
  }
  const startedAt = Date.now();
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt } });
  const message = { role: "assistant", content: [{ type: "text", text }] };
  await persistSessionTranscriptTurn(
    {
      sessionId,
      sessionKey: opts.sessionKey,
      ...(testState.sessionStorePath ? { storePath: testState.sessionStorePath } : {}),
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: [{ message, now: Date.now() }],
    },
  );
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      startedAt,
      endedAt: Date.now(),
      terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
    },
  });
}

// The model/command seam is deterministic; admission, continuation authority,
// final tool construction, execution guards, and filesystem effects stay real.
export async function withSessionSendReceiverTools(
  opts: AgentCommandGatewayIngressOpts,
  config: OpenClawConfig,
  dir: string,
  run: (tools: ReturnType<typeof createOpenClawCodingTools>) => Promise<void>,
): Promise<void> {
  const admission = prepareAgentCommandExecutionIdentity({
    opts,
    prepared: {
      cfg: config,
      runId: opts.runId!,
      sessionAgentId: "main",
      sessionId: opts.sessionId ?? "main",
      sessionKey: opts.sessionKey,
    },
    ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
    lifecycleGeneration: opts.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
  });
  try {
    const admittedRunContext = await admission.admit("embedded");
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId: "main",
      sessionKey: opts.sessionKey!,
    });
    await withGatewayToolCallerIdentity(identity, async () =>
      run(
        createOpenClawCodingTools({
          config,
          agentId: "main",
          sessionKey: opts.sessionKey,
          senderIsOwner: true,
          cwd: dir,
          workspaceDir: dir,
        }),
      ),
    );
  } finally {
    await admission.finish();
  }
}

export async function runSessionsSendAnnounceAuthorityScenario(params: {
  cancelRequest: boolean;
  gatewayContext: GatewayRequestContext;
  makeTempDir: (prefix: string) => string;
}): Promise<void> {
  const dir = params.makeTempDir("openclaw-sessions-send-announce-effect-");
  const effectPath = path.join(dir, "announce.txt");
  const sourceSessionKey = "agent:main:cron:announce-proof:run:source";
  const sourceAbort = new AbortController();
  const requestAbort = new AbortController();
  const sourceAdmission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef("announce-effect-source"),
    facts: {
      runId: "announce-effect-source",
      agentId: "main",
      ingress: { kind: "system", boundary: "sessions-send-effect-test", state: "present" },
    },
    cancellationSignal: sourceAbort.signal,
  });
  const releaseEffect = createDeferred();
  let primaryCompleted = false;
  let primaryRunId: string | undefined;
  let announceRunId: string | undefined;
  let effectError: unknown;
  let effectResult: unknown;
  let announceSettled = false;
  const spy = agentCommandMock as unknown as Mock<
    (opts: AgentCommandGatewayIngressOpts) => Promise<void>
  >;
  spy.mockImplementation(async (opts) => {
    await opts.userTurnTranscriptRecorder?.persistApproved();
    if (opts.transcriptMessage === undefined) {
      expect(primaryRunId).toBeUndefined();
      primaryRunId = opts.runId;
      await withSessionSendReceiverTools(opts, {}, dir, async () => {});
      primaryCompleted = true;
      await emitLifecycleAssistantReply(opts, "primary completed");
      return;
    }
    try {
      await withSessionSendReceiverTools(opts, {}, dir, async (tools) => {
        expect(primaryCompleted).toBe(true);
        expect(opts.transcriptMessage).toBe("");
        expect(opts.runId).not.toBe(primaryRunId);
        const write = tools.find((tool) => tool.name === "write");
        expect(write).toBeDefined();
        announceRunId = opts.runId;
        // Pause only after direct announcement admission and tool capture.
        await releaseEffect.promise;
        try {
          effectResult = await write!.execute("announce-file-effect", {
            path: "announce.txt",
            content: "announcement completed\n",
          });
        } catch (error) {
          effectError = error;
        }
      });
    } finally {
      announceSettled = true;
    }
  });
  try {
    const sourceContext = await sourceAdmission.admit("embedded");
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: sourceContext,
      agentId: "main",
      sessionKey: sourceSessionKey,
    });
    const result = await withPluginRuntimeGatewayContextResolver(
      () => params.gatewayContext,
      () =>
        withGatewayToolCallerIdentity(identity, async () => {
          const tools = createOpenClawCodingTools({
            config: { tools: { sessions: { visibility: "all" } } },
            agentId: "main",
            sessionKey: sourceSessionKey,
            senderIsOwner: true,
            abortSignal: sourceAbort.signal,
          });
          return tools
            .find((tool) => tool.name === "sessions_send")!
            .execute(
              "announce-proof-send",
              { sessionKey: "main", message: "perform the announcement effect", timeoutSeconds: 5 },
              requestAbort.signal,
            );
        }),
    );
    expect(result.details).toMatchObject({ status: "ok" });
    await vi.waitFor(() => expect(announceRunId).toBeDefined());
    // Normal foreground completion must not revoke its separately admitted follow-up.
    sourceAdmission.close();
    expect(getAdmittedRunDelegatedAuthority(sourceContext)).toBeUndefined();
    expect(sourceAbort.signal.aborted).toBe(false);
    if (params.cancelRequest) {
      requestAbort.abort(new Error("individual sessions_send request cancelled"));
    }
    releaseEffect.resolve();
    await vi.waitFor(() => expect(announceSettled).toBe(true));
    if (params.cancelRequest) {
      await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(effectError).toMatchObject({
        message: expect.stringContaining("authority is no longer active"),
      });
      expect(effectResult).toBeUndefined();
    } else {
      expect(effectError).toBeUndefined();
      await expect(fs.readFile(effectPath, "utf8")).resolves.toBe("announcement completed\n");
    }
    console.info(
      `sessions_send announce proof: primary completed; distinct direct target admitted; source completed; request ${params.cancelRequest ? "cancelled; file absent" : "live; file written"}`,
    );
  } finally {
    releaseEffect.resolve();
    sourceAdmission.close();
    await waitForGatewayActiveWork();
  }
}

export async function runSessionsSendAuthorityScenario(params: {
  testCase: SessionSendAuthorityCase;
  gatewayContext: GatewayRequestContext;
  makeTempDir: (prefix: string) => string;
}): Promise<void> {
  const { testCase } = params;
  const dir = params.makeTempDir(`openclaw-sessions-send-effect-${testCase.mode}-`);
  const effectPath = path.join(dir, "effect.txt");
  const spy = agentCommandMock as unknown as Mock<
    (opts: AgentCommandGatewayIngressOpts) => Promise<void>
  >;
  const config: OpenClawConfig = {
    tools: {
      sessions: { visibility: "all" },
      ...(testCase.denyWrite ? { deny: ["write"] } : {}),
    },
  };
  const sourceRunId = `source-effect-${testCase.mode}`;
  const sourceAbort = new AbortController();
  const executeAbort = new AbortController();
  const sourceAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(sourceRunId),
    facts: {
      runId: sourceRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "sessions-send-effect-test", state: "present" },
    },
    cancellationSignal: sourceAbort.signal,
  });
  const targetEffectSettled = createDeferred();
  let receiverWriteAvailable: boolean | undefined;
  let targetEffectError: unknown;
  let targetEffectResult: unknown;
  let handledPrimaryRun = false;
  spy.mockImplementation(async (opts) => {
    await opts.userTurnTranscriptRecorder?.persistApproved();
    if (handledPrimaryRun) {
      await emitLifecycleAssistantReply(opts);
      return;
    }
    handledPrimaryRun = true;
    const targetRunId = opts.runId ?? `target-effect-${testCase.mode}`;
    const targetAdmission = prepareAgentCommandExecutionIdentity({
      opts,
      prepared: {
        cfg: {},
        runId: targetRunId,
        sessionAgentId: "main",
        sessionId: opts.sessionId ?? "main",
        sessionKey: opts.sessionKey,
      },
      ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
      lifecycleGeneration: opts.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    });
    try {
      const admittedRunContext = await targetAdmission.admit("embedded");
      const targetIdentity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey: opts.sessionKey ?? "main",
      });
      const receiverTools = await withGatewayToolCallerIdentity(targetIdentity, async () =>
        createOpenClawCodingTools({
          config: {},
          agentId: "main",
          sessionKey: opts.sessionKey,
          senderIsOwner: true,
          cwd: dir,
          workspaceDir: dir,
        }),
      );
      const writeTool = receiverTools.find((tool) => tool.name === "write");
      receiverWriteAvailable = Boolean(writeTool);
      if (testCase.cancelSignal === "run") {
        sourceAbort.abort(new Error("source send cancelled"));
      } else if (testCase.cancelSignal === "execute") {
        executeAbort.abort(new Error("source tool request cancelled"));
      }
      if (writeTool) {
        try {
          targetEffectResult = await withGatewayToolCallerIdentity(targetIdentity, async () =>
            writeTool.execute("delegated-file-effect", {
              path: "effect.txt",
              content: `${testCase.mode}\n`,
            }),
          );
        } catch (error) {
          targetEffectError = error;
        }
      }
    } finally {
      await emitLifecycleAssistantReply(opts);
      await targetAdmission.finish();
      targetEffectSettled.resolve();
    }
  });
  try {
    let result: { details?: unknown } | undefined;
    let sendError: unknown;
    try {
      result = await withPluginRuntimeGatewayContextResolver(
        () => params.gatewayContext,
        async () => {
          const admittedRunContext = await sourceAdmission.admit("embedded");
          const sourceIdentity = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext,
            approvalSignals: [sourceAbort.signal],
            agentId: "main",
            sessionKey: "agent:main:source",
          });
          const sourceTools = await withGatewayToolCallerIdentity(sourceIdentity, async () =>
            createOpenClawCodingTools({
              config,
              agentId: "main",
              sessionKey: "agent:main:source",
              senderIsOwner: true,
              abortSignal: sourceAbort.signal,
            }),
          );
          expect(sourceTools.map((tool) => tool.name).includes("write")).toBe(!testCase.denyWrite);
          return await withGatewayToolCallerIdentity(sourceIdentity, async () =>
            sourceTools
              .find((tool) => tool.name === "sessions_send")!
              .execute(
                "capped-gateway-effect",
                {
                  sessionKey: "main",
                  message: "perform the delegated file effect",
                  timeoutSeconds: 5,
                },
                executeAbort.signal,
              ),
          );
        },
      );
    } catch (error) {
      sendError = error;
    }
    await targetEffectSettled.promise;
    if (testCase.mode === "allowed") {
      expect(sendError).toBeUndefined();
      expect(result?.details, JSON.stringify(result?.details)).toMatchObject({ status: "ok" });
      expect(receiverWriteAvailable).toBe(true);
      expect(targetEffectError).toBeUndefined();
      await expect(fs.readFile(effectPath, "utf8")).resolves.toBe("allowed\n");
    } else {
      expect(sendError === undefined).toBe(testCase.mode === "denied");
      expect(receiverWriteAvailable).toBe(testCase.mode !== "denied");
      if (testCase.cancelSignal) {
        expect(targetEffectError).toBeInstanceOf(Error);
        expect(targetEffectResult).toBeUndefined();
      }
      await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    sourceAdmission.close();
    await waitForGatewayActiveWork();
  }
}
