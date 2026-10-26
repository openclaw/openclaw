import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { closeHttpServer } from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { createStartupRecoveryFixture } from "./server.startup-recovery.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it(
  "admits startup resends as mailbox inputs ahead of same-session WebChat and keeps child context out of a reset parent",
  { timeout: 90_000 },
  async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "startup-recovery-session";
    const recoveryMessage = "Resume this interrupted task after restart.";
    const canceledMessage = "Cancel this queued browser turn.";
    const survivorMessage = "Run this browser turn after recovery.";
    const afterResetMessage = "Resume only the work created after this reset.";
    const secondSessionKey = "agent:main:second";
    const secondSessionId = "startup-recovery-second-session";
    const secondRecoveryMessage = "Finish the second interrupted job.";
    const originalChildMarker = "recovery-child-before-reset";
    const currentChildMarker = "recovery-child-after-reset";
    const afterResetRequest = createDeferred<string>();
    const readPrompt = (payload: string, ...markers: string[]) => {
      const request: unknown = JSON.parse(payload);
      const input = isRecord(request) && Array.isArray(request.input) ? request.input : [];
      const prompts = input.flatMap((message: unknown) => {
        const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
        return content.flatMap((part: unknown) => {
          const text = isRecord(part) && typeof part.text === "string" ? part.text : undefined;
          return text && markers.every((marker) => text.includes(marker)) ? [text] : [];
        });
      });
      expect(prompts).toHaveLength(1);
      return prompts[0] ?? "";
    };
    const readRecoveryPrompt = (payload: string) =>
      readPrompt(
        payload,
        "Your previous turn was interrupted by a gateway restart",
        "Unfinished child sessions to reconcile:",
      );
    const recoveryGate = createDeferred();
    const secondRecoveryGate = createDeferred();
    const targetRequests: string[] = [];
    const secondRequests: string[] = [];
    let holdRecovery = false;
    const {
      state,
      provider: providerServer,
      cfg,
      token,
      responseCount,
    } = await createStartupRecoveryFixture(
      "startup-recovery-webchat",
      async (body) => {
        if (
          [recoveryMessage, canceledMessage, survivorMessage, afterResetMessage].some((text) =>
            body.includes(text),
          )
        ) {
          targetRequests.push(body);
        }
        if (body.includes(secondRecoveryMessage)) {
          secondRequests.push(body);
          await secondRecoveryGate.promise;
        }
        if (body.includes(afterResetMessage)) {
          afterResetRequest.resolve(body);
        }
        if (holdRecovery && body.includes(recoveryMessage)) {
          holdRecovery = false;
          await recoveryGate.promise;
        }
      },
      { maxConcurrent: 2, responseText: "WEBCHAT_OK" },
    );
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
    const startupRecoveryStop = new AbortController();
    let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>> | undefined;

    try {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const scope = (key = sessionKey, id = sessionId) => ({
        agentId: "main",
        storePath,
        sessionKey: key,
        sessionId: id,
      });
      const readSession = (key = sessionKey) => loadSessionEntryReadOnly(scope(key));
      const physicalStore = (key = sessionKey, path = storePath) =>
        resolvePhysicalSessionStorePath({ agentId: "main", sessionKey: key, storePath: path });
      const interrupted = (cycleId: string) => ({
        status: "interrupted" as const,
        abortedLastRun: true,
        mainRestartRecovery: { cycleId, revision: 1, chargedAttempts: 0 },
        updatedAt: Date.now() - 10_000,
      });
      const saveChild = (child: SubagentRunRecord) =>
        mutateSubagentRuns([child.runId], () => ({
          value: undefined,
          postimages: new Map([[child.runId, child]]),
        }));
      const recoverySessions = [
        {
          key: sessionKey,
          id: sessionId,
          message: recoveryMessage,
          source: "startup-recovery-source:user",
          cycleId: "before-reset",
        },
        {
          key: secondSessionKey,
          id: secondSessionId,
          message: secondRecoveryMessage,
          source: "startup-recovery-second-source:user",
          cycleId: "second-session",
        },
      ];
      for (const { key, id, message, source } of recoverySessions) {
        await replaceSessionEntry(scope(key, id), {
          sessionId: id,
          updatedAt: Date.now() + 60_000,
          status: "done",
        });
        await appendTranscriptMessage(scope(key, id), {
          cwd: state.workspaceDir,
          message: { role: "user", content: message, idempotencyKey: source },
        });
      }
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        clientDisplayName: "startup-recovery-webchat",
      });
      await gateway.server.startupSettled;
      const client = gateway.client;
      const waitOk = (runId: string | undefined) =>
        expect(client.request("agent.wait", { runId, timeoutMs: 30_000 })).resolves.toMatchObject({
          status: "ok",
        });
      const waitRequests = (requests: string[], count: number) =>
        vi.waitFor(() => expect(requests).toHaveLength(count), { timeout: 30_000 });
      const execution = await observeGatewayRunExecution();
      requestExecution = execution;

      const warmupRunId = "startup-recovery-warmup";
      await client.request("agent", {
        sessionKey: `agent:main:${warmupRunId}`,
        message: "Warm the agent runtime before timing recovery.",
        deliver: false,
        idempotencyKey: warmupRunId,
      });
      await waitOk(warmupRunId);
      expect(responseCount()).toBeGreaterThan(0);
      targetRequests.length = 0;

      for (const { key, id, cycleId } of recoverySessions) {
        await replaceSessionEntry(scope(key, id), { sessionId: id, ...interrupted(cycleId) });
      }
      clearSessionStoreCacheForTest();
      const addRecoveryChild = async (marker: string) => {
        const parent = expectDefined(readSession(), "recovery parent");
        const child = createSubagentRunRecord({
          runId: marker,
          childSessionKey: `agent:main:subagent:${marker}`,
          childAgentId: "main",
          childSessionIdentity: { sessionId: `session-${marker}` },
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterStorePath: physicalStore(),
          completionRequesterSessionId: parent.sessionId,
          completionRequesterLifecycleRevision: parent.lifecycleRevision,
          label: marker,
          expectsCompletionMessage: false,
          cleanupHandled: true,
          cleanupCompletedAt: Date.now(),
          execution: {
            status: "terminal",
            endedAt: Date.now(),
            outcome: { status: "error", error: "Interrupted by restart" },
            interruptionReason: "gateway-restart",
          },
        });
        await saveChild(child);
      };
      await addRecoveryChild(originalChildMarker);
      const recoveryRuntime = expectDefined(getGatewayRecoveryRuntime(), "recovery runtime");
      const startRecovery = (signal?: AbortSignal) =>
        recoverRestartAbortedMainSessions({
          cfg,
          stateDir: state.stateDir,
          gatewayRuntime: recoveryRuntime,
          signal,
        });
      holdRecovery = true;
      recovery = startRecovery(startupRecoveryStop.signal);
      await waitRequests(targetRequests, 1);
      expect(readRecoveryPrompt(targetRequests[0] ?? "")).toContain(originalChildMarker);
      const resendRunId = readSession()?.restartRecoveryDeliveryRunId;
      const resendSource = getRpcSource(expectDefined(resendRunId, "resend run id"));
      expect(resendSource?.input.claim).toBeDefined();

      const canceledRunId = "webchat-canceled-during-recovery";
      const survivorRunId = "webchat-survives-recovery";
      const sendQueuedTurn = async (runId: string, message: string) => {
        await expect(
          client.request("chat.send", {
            sessionKey,
            sessionId,
            message,
            deliver: false,
            queueMode: "followup",
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
        // ACK precedes admission; join dispatch before observing queued custody.
        await execution.waitForDispatch(runId);
        await expect(client.request("agent.wait", { runId, timeoutMs: 0 })).resolves.toMatchObject({
          runId,
          status: "pending",
          timeoutPhase: "queue",
          providerStarted: false,
        });
      };
      // Hold the cancellation target in controller custody before queueing the survivor.
      await sendQueuedTurn(canceledRunId, canceledMessage);
      await vi.waitFor(() => expect(getRpcSource(canceledRunId)).toBeDefined());
      const canceledSource = getRpcSource(canceledRunId)!;
      await sendQueuedTurn(survivorRunId, survivorMessage);
      await vi.waitFor(() => {
        expect(getRpcSource(canceledRunId)).toBe(canceledSource);
        expect(getRpcSource(survivorRunId)).toBeDefined();
      });
      const survivorSource = getRpcSource(survivorRunId)!;
      expect(survivorSource.input.mailbox).toBe(resendSource?.input.mailbox);
      expect(survivorSource.input.sequence).toBeGreaterThan(resendSource!.input.sequence);
      expect(survivorSource.input.claim).toBeUndefined();
      expect(targetRequests).toHaveLength(1);
      await expect(
        client.request("chat.abort", { sessionKey, runId: canceledRunId }),
      ).resolves.toMatchObject({ aborted: true, runIds: [canceledRunId] });
      await vi.waitFor(() => {
        expect(canceledSource.input.abortSignal.aborted).toBe(true);
        expect(getRpcSource(survivorRunId)).toBeDefined();
      });

      recoveryGate.resolve();
      await expect(recovery).resolves.toMatchObject({ started: 2, failed: 0 });
      await waitRequests(secondRequests, 1);
      const secondResendRunId = expectDefined(
        readSession(secondSessionKey)?.restartRecoveryDeliveryRunId,
        "second resend run id",
      );
      const secondResendSource = expectDefined(
        getRpcSource(secondResendRunId),
        "second resend controller source",
      );
      const secondTarget = expectDefined(secondResendSource.input.target, "second resend target");
      expect(secondTarget).toMatchObject({
        sessionKey: secondSessionKey,
        agentId: "main",
        incarnation: secondSessionId,
      });
      expect(physicalStore(secondSessionKey, secondTarget.storeScope)).toBe(
        physicalStore(secondSessionKey),
      );
      expect(secondResendSource.input.claim).toBeDefined();
      expect(secondResendSource.input.mailbox).not.toBe(resendSource?.input.mailbox);
      secondRecoveryGate.resolve();
      await waitOk(resendRunId);
      await waitRequests(targetRequests, 2);
      expect(targetRequests[1]).toContain(survivorMessage);
      expect(targetRequests[1]).not.toContain(canceledMessage);
      await waitOk(survivorRunId);
      await vi.waitFor(() => expect(getRpcSource(survivorRunId)).toBeUndefined());
      // The sweep reports admission; join this exact resend before inspecting its durable result.
      await waitOk(secondResendRunId);
      await secondResendSource.input.settlement.promise;
      expect(readSession(secondSessionKey)).toMatchObject({
        abortedLastRun: false,
        status: "done",
      });
      expect(secondRequests).toHaveLength(1);
      expect(targetRequests).toHaveLength(2);

      const beforeReset = readSession();
      await client.request("sessions.reset", { key: sessionKey });
      const afterReset = readSession();
      expect(afterReset?.sessionId).toBe(beforeReset?.sessionId);
      expect(afterReset?.lifecycleRevision).not.toBe(beforeReset?.lifecycleRevision);
      await appendTranscriptMessage(scope(), {
        message: { role: "user", content: afterResetMessage },
      });
      await patchSessionEntryCore(scope(), (entry) => ({
        ...entry,
        ...interrupted("after-reset"),
      }));
      await addRecoveryChild(currentChildMarker);
      const [resetResult, providerPayload] = await Promise.all([
        startRecovery(),
        afterResetRequest.promise,
      ]);
      expect(resetResult).toMatchObject({ started: 1, failed: 0 });
      const resetPrompt = readRecoveryPrompt(providerPayload);
      expect(resetPrompt).toContain(currentChildMarker);
      expect(resetPrompt).not.toContain(originalChildMarker);

      const resetRunId = readSession()?.lifecycleRunId;
      expect(typeof resetRunId).toBe("string");
      await waitOk(resetRunId);
    } finally {
      recoveryGate.resolve();
      secondRecoveryGate.resolve();
      startupRecoveryStop.abort();
      if (recovery) {
        await Promise.allSettled([recovery]);
      }
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      if (providerServer.listening) {
        await closeHttpServer(providerServer);
      }
      await requestExecution?.restore();
      subagentRuns.delete(originalChildMarker);
      subagentRuns.delete(currentChildMarker);
      await state.cleanup();
    }
  },
);
