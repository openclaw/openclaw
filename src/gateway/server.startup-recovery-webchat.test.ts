import { createServer } from "node:http";
import { text as readStreamText } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import {
  mutateRequesterCompletionBatch,
  SubagentCompletionSourceChangedError,
} from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "../agents/subagents/registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { isSameSubagentRun } from "../agents/subagents/registry/subagent-run-generation.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "admits startup resends as mailbox inputs ahead of same-session WebChat and keeps child context out of a reset parent",
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
    const secondSessionKey = "agent:main:second";
    const secondSessionId = "startup-recovery-second-session";
    const secondRecoveryMessage = "Finish the second interrupted job.";
    const originalChildMarker = "recovery-child-before-reset";
    const currentChildMarker = "recovery-child-after-reset";
    const batchChildMarker = "saved-batch-child";
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
    const readBatchPrompt = (payload: string) =>
      readPrompt(payload, "[Subagent Context] Every subagent in this batch has now settled");
    const recoveryGate = createDeferred();
    const secondRecoveryGate = createDeferred();
    const targetRequests: string[] = [];
    const secondRequests: string[] = [];
    const batchRequests: string[] = [];
    let holdRecovery = false;
    let providerRequestCount = 0;
    const providerServer = createServer((request, response) => {
      void (async () => {
        const body = await readStreamText(request);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        if (!body.includes("Generate a concise session title")) {
          if (body.includes("Every subagent in this batch has now settled")) {
            batchRequests.push(body);
          }
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
    const startupRecoveryStop = new AbortController();
    let gatewayContext: GatewayRequestContext | undefined;
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
      const provider = buildMockOpenAiResponsesProvider(
        `${await listenLoopback(providerServer)}/v1`,
        "gpt-startup-recovery-webchat",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            maxConcurrent: 2,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: {} },
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
      expect(providerRequestCount).toBeGreaterThan(0);
      targetRequests.length = 0;

      for (const { key, id, cycleId } of recoverySessions) {
        await replaceSessionEntry(scope(key, id), { sessionId: id, ...interrupted(cycleId) });
      }
      clearSessionStoreCacheForTest();
      const addRecoveryChild = async (
        marker: string,
        overrides: Partial<SubagentRunRecord> = {},
      ) => {
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
          ...overrides,
        });
        await saveChild(child);
        return child;
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
      if (!gatewayContext) {
        throw new Error("Saved-batch proof needs the active Gateway owner");
      }
      // Retire startup's registry sweep so manual replays are the only claimants.
      const registry = Reflect.get(globalThis, Symbol.for("openclaw.subagentRegistryTestApi")) as {
        resetSubagentRegistryForTests(options: { persist: false }): Promise<void>;
      };
      await registry.resetSubagentRegistryForTests({ persist: false });
      const resolver = () => gatewayContext;
      const reloadSavedBatch = async (entry: SubagentRunRecord) => {
        await saveChild(entry);
        await restoreSubagentRunsFromDisk({ runs: subagentRuns });
        const saved = expectDefined(
          subagentRuns.get(entry.runId),
          "SQLite-restored completion batch",
        );
        bindGatewayContextResolver(saved, resolver);
        return saved;
      };
      const currentBatch = (batch: readonly SubagentRunRecord[], generation?: number) =>
        batch.map((member) => {
          const current = subagentRuns.get(member.runId);
          if (
            !current ||
            !isSameSubagentRun(current, member) ||
            current.requesterSettleWake?.rearmGeneration !==
              (generation ?? member.requesterSettleWake?.rearmGeneration)
          ) {
            throw generation === undefined
              ? new Error("Saved batch owner changed")
              : new SubagentCompletionSourceChangedError("Saved batch owner changed");
          }
          return current;
        });
      const wakeSavedBatch = (entry: SubagentRunRecord) =>
        maybeWakeRequesterAfterAllChildrenSettled({
          isSourceCurrent: () => true,
          requesterSessionKey: sessionKey,
          settledEntry: entry,
          transitionBatch: async (batch, next, onPublished) => {
            const result = await mutateRequesterCompletionBatch({
              entries: batch,
              operation: { kind: "transition", state: next },
              context: captureOpenClawStateWorkerContext(),
              assertCurrent: () => currentBatch(batch),
              onCommitted: () => {},
              onPublished: () => {
                const published = currentBatch(batch);
                onPublished?.(published);
              },
            });
            expect(result.publication).toBe("published");
          },
          completeBatch: async (batch, rearmGeneration, outcome, onCommitted) => {
            const result = await mutateRequesterCompletionBatch({
              entries: batch,
              operation: {
                kind: "settle",
                outcome: expectDefined(outcome, "batch delivery outcome"),
              },
              assertCurrent: () => currentBatch(batch, rearmGeneration),
            });
            expect(result.publication).toBe("published");
            await onCommitted?.();
          },
        });
      const pendingWake = (rearmGeneration: number): SubagentRunRecord["requesterSettleWake"] => ({
        status: "pending",
        attemptCount: 0,
        batchRunIds: [batchChildMarker],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration,
      });
      const batchResult = "saved interrupted batch result";
      let batchChild = await addRecoveryChild(batchChildMarker, {
        expectsCompletionMessage: true,
        completion: {
          required: true,
          resultText: batchResult,
          terminalReply: { disposition: "visible", text: batchResult },
        },
        delivery: { status: "delivered" },
        requesterSettleWake: pendingWake(1),
      });
      const batchChildSessionId = expectDefined(
        batchChild.childSessionIdentity?.sessionId,
        "saved batch child session id",
      );
      const batchChildScope = scope(batchChild.childSessionKey, batchChildSessionId);
      await replaceSessionEntry(batchChildScope, {
        sessionId: batchChildSessionId,
        updatedAt: Date.now(),
      });
      await persistSessionTranscriptTurn(batchChildScope, {
        config: cfg,
        runId: batchChild.runId,
        expectedSessionId: batchChildSessionId,
        touchSessionEntry: false,
        updateMode: "none",
        messages: [
          {
            message: {
              role: "assistant",
              phase: "final_answer",
              stopReason: "stop",
              content: [{ type: "text", text: batchResult }],
            },
          },
        ],
      });
      batchChild = await reloadSavedBatch(batchChild);
      expect(await wakeSavedBatch(batchChild)).toBe(true);
      expect(batchRequests).toHaveLength(1);
      const ownedBatchPrompt = readBatchPrompt(batchRequests[0] ?? "");
      expect(ownedBatchPrompt).toContain("Unfinished child sessions to reconcile:");
      expect(ownedBatchPrompt).toContain(`"sessionKey": "${batchChild.childSessionKey}"`);
      expect(subagentRuns.get(batchChild.runId)?.requesterSettleWake).toBeUndefined();

      batchChild = await reloadSavedBatch({
        ...expectDefined(
          loadSubagentRegistryFromSqlite().get(batchChild.runId),
          "settled batch child",
        ),
        requesterSettleWake: pendingWake(2),
      });
      const fixtureHistory = structuredClone(batchChild);
      await client.request("sessions.reset", { key: sessionKey });
      const revokedTransition = vi.fn();
      const revokedCompletion = vi.fn();
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled({
          isSourceCurrent: () => true,
          requesterSessionKey: sessionKey,
          settledEntry: batchChild,
          transitionBatch: revokedTransition,
          completeBatch: revokedCompletion,
        }),
      ).toBe(false);
      expect(revokedTransition).not.toHaveBeenCalled();
      expect(revokedCompletion).not.toHaveBeenCalled();
      expect(batchRequests).toHaveLength(1);
      const resetBatchParent = readSession();
      expect(resetBatchParent?.sessionId).toBe(fixtureHistory.completionRequesterSessionId);
      expect(resetBatchParent?.lifecycleRevision).not.toBe(
        fixtureHistory.completionRequesterLifecycleRevision,
      );
      // Restore old history explicitly: reset revoked the live wake, so this is compatibility.
      batchChild = await reloadSavedBatch(fixtureHistory);
      expect(await wakeSavedBatch(batchChild)).toBe(true);
      expect(batchRequests).toHaveLength(2);
      const staleBatchPrompt = readBatchPrompt(batchRequests[1] ?? "");
      expect(staleBatchPrompt).toContain(batchResult);
      expect(staleBatchPrompt).not.toContain("Unfinished child sessions to reconcile:");
      expect(staleBatchPrompt).not.toContain(`"sessionKey": "${batchChild.childSessionKey}"`);
      expect(staleBatchPrompt).not.toContain("parent recovery required");
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
      subagentRuns.delete(batchChildMarker);
      await state.cleanup();
    }
  },
);
