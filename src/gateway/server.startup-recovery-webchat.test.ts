import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../agents/main-session-recovery/main-session-recovery-admission.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import { settleRequesterCompletionBatch } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { loadSubagentRunsByRunIdsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionOwnerRelease,
} from "../sessions/session-lifecycle-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countPendingQueueItems } from "../utils/queue-helpers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "queues WebChat behind recovery and keeps child context out of a reset parent",
  { timeout: 90_000 },
  async () => {
    const token = "startup-recovery-webchat-token";
    const state = await createOpenClawTestState({
      label: "startup-recovery-webchat",
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const sessionKey = "agent:main:main";
    const sessionId = "startup-recovery-session";
    const recoveryMessage = "Resume this interrupted task after restart.";
    const canceledMessage = "Cancel this queued browser turn.";
    const survivorMessage = "Run this browser turn after recovery.";
    const afterResetMessage = "Resume only the work created after this reset.";
    const originalChildMarker = "recovery-child-before-reset";
    const currentChildMarker = "recovery-child-after-reset";
    const batchChildMarker = "saved-batch-child";
    const afterResetRequest = createDeferred<string>();
    const readPromptFrames = (payload: string) => {
      const request: unknown = JSON.parse(payload);
      const input = isRecord(request) && Array.isArray(request.input) ? request.input : [];
      return input.flatMap((message: unknown) => {
        const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
        return content.flatMap((part: unknown) =>
          isRecord(part) && typeof part.text === "string" ? [part.text] : [],
        );
      });
    };
    const readRecoveryPrompt = (payload: string) => {
      const prompts = readPromptFrames(payload).filter(
        (text) =>
          text.includes("Your previous turn was interrupted by a gateway restart") &&
          text.includes("Unfinished child sessions to reconcile:"),
      );
      expect(prompts).toHaveLength(1);
      return prompts[0] ?? "";
    };
    const readBatchPrompt = (payload: string) => {
      const prompts = readPromptFrames(payload).filter((text) =>
        text.includes("[Subagent Context] Every subagent in this batch has now settled"),
      );
      expect(prompts).toHaveLength(1);
      return prompts[0] ?? "";
    };
    const recoveryGate = createDeferred();
    const targetRequests: string[] = [];
    const batchRequests: string[] = [];
    let holdRecovery = false;
    let providerRequestCount = 0;
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const isTitleRequest = body.includes("Generate a concise session title");
        if (!isTitleRequest && body.includes("Every subagent in this batch has now settled")) {
          batchRequests.push(body);
        }
        if (
          !isTitleRequest &&
          [recoveryMessage, canceledMessage, survivorMessage, afterResetMessage].some((text) =>
            body.includes(text),
          )
        ) {
          targetRequests.push(body);
        }
        if (!isTitleRequest && body.includes(afterResetMessage)) {
          afterResetRequest.resolve(body);
        }
        if (holdRecovery && !isTitleRequest && body.includes(recoveryMessage)) {
          holdRecovery = false;
          await recoveryGate.promise;
        }
        providerRequestCount += 1;
        writeOpenAiResponsesText(response, {
          text: "WEBCHAT_OK",
          messageId: `startup-recovery-${providerRequestCount}`,
          responseId: `startup-recovery-response-${providerRequestCount}`,
        });
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
    let replacementOwner: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let gatewayContext: GatewayRequestContext | undefined;

    try {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, updatedAt: Date.now() + 60_000, status: "done" },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          cwd: state.workspaceDir,
          message: {
            role: "user",
            content: recoveryMessage,
            idempotencyKey: "startup-recovery-source:user",
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("startup recovery provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "gpt-startup-recovery-webchat",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            maxConcurrent: 1,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: { default: true } },
        },
        messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
      } satisfies OpenClawConfig;
      const kernelModule = await import("./server-kernel.js");
      const createKernel = kernelModule.createGatewayKernel;
      const captureKernel = vi
        .spyOn(kernelModule, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          const kernel = await createKernel(...args);
          gatewayContext = kernel.gatewayRequestContext;
          return kernel;
        });
      try {
        gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          token,
          clientDisplayName: "startup-recovery-webchat",
        });
      } finally {
        captureKernel.mockRestore();
      }
      await gateway.server.startupSettled;
      const client = gateway.client;

      const warmupRunId = "startup-recovery-warmup";
      await client.request("agent", {
        sessionKey: `agent:main:${warmupRunId}`,
        message: "Warm the agent runtime before timing recovery.",
        deliver: false,
        idempotencyKey: warmupRunId,
      });
      await expect(
        client.request("agent.wait", { runId: warmupRunId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(providerRequestCount).toBeGreaterThan(0);
      targetRequests.length = 0;

      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId,
          updatedAt: Date.now() - 10_000,
          status: "running",
          abortedLastRun: true,
        },
      );
      clearSessionStoreCacheForTest();
      const addRecoveryChild = (marker: string) => {
        const parent = loadSessionEntryReadOnly({ storePath, sessionKey });
        if (!parent) {
          throw new Error("Recovery parent is missing");
        }
        const child = createSubagentRunRecord({
          runId: marker,
          childSessionKey: `agent:main:subagent:${marker}`,
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterStorePath: resolvePhysicalSessionStorePath({
            agentId: "main",
            storePath,
            sessionKey,
          }),
          completionRequesterSessionId: parent.sessionId,
          completionRequesterLifecycleRevision: parent.lifecycleRevision,
          label: marker,
          expectsCompletionMessage: false,
          cleanupHandled: true,
          cleanupCompletedAt: Date.now(),
          completion: { required: false },
          delivery: { status: "not_required" },
          execution: {
            status: "terminal",
            endedAt: Date.now(),
            outcome: { status: "error", error: "Interrupted by restart" },
            interruptionReason: "gateway-restart",
          },
        });
        subagentRuns.set(child.runId, child);
        persistSubagentRunsToDiskOrThrow(subagentRuns, [child.runId]);
        return child;
      };
      addRecoveryChild(originalChildMarker);
      const recoveryRuntime = getGatewayRecoveryRuntime();
      if (!recoveryRuntime) {
        throw new Error("Gateway recovery runtime is unavailable");
      }
      holdRecovery = true;
      recovery = recoverRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        gatewayRuntime: recoveryRuntime,
      });
      await vi.waitFor(() => expect(targetRequests).toHaveLength(1), { timeout: 30_000 });
      expect(readRecoveryPrompt(targetRequests[0] ?? "").includes(originalChildMarker)).toBe(true);
      const initialOwner = getSessionWorkAdmissionOwnerRelease({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      });
      expect(initialOwner).toBeInstanceOf(Promise);
      if (!initialOwner) {
        throw new Error("startup recovery did not own the main session");
      }

      const canceledRunId = "webchat-canceled-during-recovery";
      const survivorRunId = "webchat-survives-recovery";
      const expectedQueuedMessages = new Map([
        [canceledRunId, canceledMessage],
        [survivorRunId, survivorMessage],
      ]);
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
      };
      // Hold the cancellation target in flight before queueing the survivor.
      // A started ACK precedes insertion into the followup queue.
      await sendQueuedTurn(canceledRunId, canceledMessage);
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        expect([...(queue?.inFlight ?? [])].map((item) => item.messageId)).toEqual([canceledRunId]);
      });
      await sendQueuedTurn(survivorRunId, survivorMessage);
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        // Active sources remain in items; started ACKs can precede queue admission.
        expect(queue?.items).toHaveLength(expectedQueuedMessages.size);
        expect(new Map(queue?.items.map(({ messageId, prompt }) => [messageId, prompt]))).toEqual(
          expectedQueuedMessages,
        );
        expect(queue?.inFlight).toHaveLength(1);
        expect(queue?.items.map((item) => item.messageId)).toEqual([canceledRunId, survivorRunId]);
        expect(countPendingQueueItems(queue?.items ?? [], queue?.inFlight)).toBe(1);
        expect(targetRequests).toHaveLength(1);
      });
      replacementOwner = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        assertAllowed: () => {},
      });

      recoveryGate.resolve();
      await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
      await initialOwner;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(targetRequests).toHaveLength(1);
      await expect(
        client.request("chat.abort", { sessionKey, runId: canceledRunId }),
      ).resolves.toMatchObject({ aborted: true, runIds: [canceledRunId] });
      await vi.waitFor(() => {
        const queue = getExistingFollowupQueue(sessionKey);
        const queued = new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]);
        expect(Array.from(queued, (item) => item.messageId)).toEqual([survivorRunId]);
      });

      replacementOwner.release();
      await vi.waitFor(() => expect(targetRequests).toHaveLength(2), { timeout: 30_000 });
      expect(targetRequests[1]).toContain(survivorMessage);
      expect(targetRequests[1]).not.toContain(canceledMessage);
      await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
      await expect(
        client.request("agent.wait", { runId: survivorRunId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(targetRequests).toHaveLength(2);

      const beforeReset = loadSessionEntryReadOnly({ storePath, sessionKey });
      await client.request("sessions.reset", { key: sessionKey });
      const afterReset = loadSessionEntryReadOnly({ storePath, sessionKey });
      expect(afterReset?.sessionId).toBe(beforeReset?.sessionId);
      expect(afterReset?.lifecycleRevision).not.toBe(beforeReset?.lifecycleRevision);
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId, storePath },
        { message: { role: "user", content: afterResetMessage } },
      );
      await patchSessionEntryCore({ storePath, sessionKey }, (entry) => ({
        ...entry,
        status: "running",
        abortedLastRun: true,
        updatedAt: Date.now() - 10_000,
      }));
      addRecoveryChild(currentChildMarker);
      const resetRecovery = recoverRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        gatewayRuntime: recoveryRuntime,
      });
      const [resetResult, providerPayload] = await Promise.all([
        resetRecovery,
        afterResetRequest.promise,
      ]);
      expect(resetResult).toMatchObject({ started: 1, failed: 0 });
      const resetPrompt = readRecoveryPrompt(providerPayload);
      expect(resetPrompt.includes(currentChildMarker)).toBe(true);
      expect(resetPrompt.includes(originalChildMarker)).toBe(false);

      const resetRunId = loadSessionEntryReadOnly({ storePath, sessionKey })?.lifecycleRunId;
      expect(typeof resetRunId).toBe("string");
      await expect(
        client.request("agent.wait", { runId: resetRunId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      if (!gatewayContext) {
        throw new Error("Saved-batch proof needs the active Gateway owner");
      }
      const resolver = () => gatewayContext;
      const reloadSavedBatch = (entry: SubagentRunRecord) => {
        subagentRuns.set(entry.runId, entry);
        persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
        subagentRuns.delete(entry.runId);
        const [saved] = loadSubagentRunsByRunIdsFromSqlite([entry.runId]);
        if (!saved) {
          throw new Error("Saved completion batch did not survive its SQLite round trip");
        }
        subagentRuns.set(saved.runId, saved);
        bindGatewayContextResolver(saved, resolver);
        return saved;
      };
      const wakeSavedBatch = (entry: SubagentRunRecord) =>
        maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey: sessionKey,
          settledEntry: entry,
          transitionBatch: (batch, next) => {
            for (const member of batch) {
              member.requesterSettleWake = next;
            }
            persistSubagentRunsToDiskOrThrow(
              subagentRuns,
              batch.map((member) => member.runId),
            );
          },
          completeBatch: async (batch, _generation, outcome, onCommitted) => {
            if (!outcome) {
              throw new Error("Saved batch did not produce a delivery outcome");
            }
            await settleRequesterCompletionBatch({
              entries: batch.map((subagent) => ({ subagent })),
              outcome,
              isCurrent: () => batch.every((member) => subagentRuns.get(member.runId) === member),
            });
            onCommitted?.();
          },
        });
      let batchChild = addRecoveryChild(batchChildMarker);
      batchChild.expectsCompletionMessage = true;
      batchChild.completion = { required: true, resultText: "saved interrupted batch result" };
      batchChild.delivery = { status: "delivered" };
      batchChild.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [batchChild.runId],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      };
      batchChild = reloadSavedBatch(batchChild);
      expect(await wakeSavedBatch(batchChild)).toBe(true);
      expect(batchRequests).toHaveLength(1);
      const ownedBatchPrompt = readBatchPrompt(batchRequests[0] ?? "");
      expect(ownedBatchPrompt).toContain("Unfinished child sessions to reconcile:");
      expect(ownedBatchPrompt).toContain(`"sessionKey": "${batchChild.childSessionKey}"`);
      expect(batchChild.requesterSettleWake).toBeUndefined();

      batchChild.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [batchChild.runId],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 2,
      };
      batchChild = reloadSavedBatch(batchChild);
      const fixtureHistory = structuredClone(batchChild);
      await client.request("sessions.reset", { key: sessionKey });
      const revokedTransition = vi.fn();
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey: sessionKey,
          settledEntry: batchChild,
          transitionBatch: revokedTransition,
          completeBatch: vi.fn(),
        }),
      ).toBe(false);
      expect(revokedTransition).not.toHaveBeenCalled();
      expect(batchRequests).toHaveLength(1);
      const resetBatchParent = loadSessionEntryReadOnly({ storePath, sessionKey });
      expect(resetBatchParent?.sessionId).toBe(fixtureHistory.completionRequesterSessionId);
      expect(resetBatchParent?.lifecycleRevision).not.toBe(
        fixtureHistory.completionRequesterLifecycleRevision,
      );
      // Current reset revoked the live wake above. This explicitly restored older
      // fixture history exercises compatibility, not a wake left behind by reset.
      batchChild = reloadSavedBatch(fixtureHistory);
      expect(await wakeSavedBatch(batchChild)).toBe(true);
      expect(batchRequests).toHaveLength(2);
      const staleBatchPrompt = readBatchPrompt(batchRequests[1] ?? "");
      expect(staleBatchPrompt).toContain("saved interrupted batch result");
      expect(staleBatchPrompt).not.toContain("Unfinished child sessions to reconcile:");
      expect(staleBatchPrompt).not.toContain(`"sessionKey": "${batchChild.childSessionKey}"`);
      expect(staleBatchPrompt).not.toContain("parent recovery required");
    } finally {
      recoveryGate.resolve();
      replacementOwner?.release();
      if (recovery) {
        await Promise.allSettled([recovery]);
      }
      clearFollowupQueue(sessionKey);
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      if (providerServer.listening) {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
      subagentRuns.delete(originalChildMarker);
      subagentRuns.delete(currentChildMarker);
      subagentRuns.delete(batchChildMarker);
      await state.cleanup();
    }
  },
);
