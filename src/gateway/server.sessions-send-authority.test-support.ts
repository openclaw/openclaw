import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
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

async function emitLifecycleAssistantReply(opts: AgentCommandGatewayIngressOpts): Promise<void> {
  const sessionId = opts.sessionId ?? "main";
  const runId = opts.runId ?? sessionId;
  if (!opts.sessionKey) {
    throw new Error("expected session key for lifecycle reply");
  }
  const startedAt = Date.now();
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt } });
  const text = "ANNOUNCE_SKIP";
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
  const targetEffectSettled = createDeferred<void>();
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
