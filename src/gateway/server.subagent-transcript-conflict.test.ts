import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import {
  mutateRequesterCompletionBatch,
  SubagentCompletionSourceChangedError,
} from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { isSameSubagentRun } from "../agents/subagents/registry/subagent-run-generation.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  activateTestChannelRegistry,
  createChannelTestPluginBase,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { closeGatewayDeviceRevocation } from "./device-revocation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "./server-plugin-in-process-authority.js";
import { subagentToolCallEvents } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

for (const scenario of [
  "followup",
  "steer",
  "conflict",
  "exhaust",
  "replaced",
  "revoked",
  "effect",
  "send",
] as const) {
  it(
    `settles a completed child safely after ${scenario} during requester synthesis`,
    { timeout: 90_000 },
    async ({ signal }) => {
      const token = "conflict-fixture-token";
      const state = await createOpenClawTestState({
        label: "completion-conflict",
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
      const sessionKey = "agent:main:main",
        sessionId = "conflict-parent-" + scenario,
        childId = "conflict-child-" + scenario;
      const warmupRunId = "fixture-" + scenario + "-warmup";
      const humanText = "New ordinary user input.",
        childText = "Durable child finding.",
        concurrentText = "Concurrent writer append.";
      let started = createDeferred(),
        release = createDeferred();
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let gatewayContext: GatewayRequestContext | undefined;
      let execution: Awaited<ReturnType<typeof observeGatewayRunExecution>> | undefined;
      let wake: Promise<boolean> | undefined;
      let originalSource: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
      let expectSynthesis = false,
        requestCount = 0,
        synthesisCount = 0,
        effectCalls = 0;
      const synthesisBodies: string[] = [];
      const sentTexts: string[] = [];
      const providerServer = createServer((req, res) => {
        void (async () => {
          const body = await readRequestText(req);
          if (req.method !== "POST" || req.url !== "/v1/responses") {
            res.writeHead(404).end();
            return;
          }
          const synthesis = expectSynthesis && body.includes(childText);
          let synthesisIndex = 0;
          if (synthesis && (scenario === "effect" || scenario === "send") && effectCalls === 0) {
            effectCalls++;
            writeOpenAiResponsesSse(
              res,
              subagentToolCallEvents(
                scenario === "send" ? "message" : "write",
                scenario === "send"
                  ? {
                      action: "send",
                      channel: "conflict-chat",
                      target: "recipient",
                      message: "One committed message.",
                    }
                  : {
                      path: path.join(state.workspaceDir, "effect.txt"),
                      content: "One committed private effect.",
                    },
                1,
              ),
            );
            return;
          }
          if (synthesis) {
            expectSynthesis = false;
            synthesisIndex = ++synthesisCount;
            synthesisBodies.push(body);
            started.resolve();
            await release.promise;
          }
          requestCount++;
          writeOpenAiResponsesText(res, {
            text: synthesis ? `Requester synthesis ${synthesisIndex}.` : "Human reply.",
            messageId: "reply-" + requestCount,
            responseId: "response-" + requestCount,
          });
        })().catch((error: unknown) => res.writeHead(500).end(String(error)));
      });
      try {
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", storePath, sessionKey, sessionId };
        await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now(), status: "done" });
        const provider = buildMockOpenAiResponsesProvider(
          (await listenLoopback(providerServer)) + "/v1",
          "fixture-model",
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
            entries: { main: {} },
          },
          messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        const kernelModule = await import("./server-kernel.js"),
          createKernel = kernelModule.createGatewayKernel;
        const capture = vi
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
            clientDisplayName: "completion-conflict",
          });
        } finally {
          capture.mockRestore();
        }
        await gateway.server.startupSettled;
        if (scenario === "send") {
          const plugin: ChannelPlugin = {
            ...createChannelTestPluginBase({
              id: "conflict-chat",
              config: {
                resolveAccount: () => ({ accountId: "default", enabled: true }),
                isEnabled: () => true,
                isConfigured: () => true,
              },
            }),
            messaging: {
              normalizeTarget: (target) => target,
              targetResolver: { looksLikeId: (target) => target === "recipient" },
            },
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) => ({ ok: true, to: to ?? "recipient" }),
              sendText: async (context) => {
                context.signal?.throwIfAborted();
                await context.onPlatformSendDispatch?.();
                context.assertDirectAdapterHandoff?.();
                sentTexts.push(context.text);
                return { channel: "conflict-chat", messageId: "committed-message" };
              },
            },
          };
          await activateTestChannelRegistry(
            createTestRegistry([{ pluginId: "conflict-chat", source: "test", plugin }]),
          );
        }
        execution = await observeGatewayRunExecution();
        const client = gateway.client;
        const tools = await import("../agents/embedded-agent-runner/run/attempt-gateway-tools.js");
        const prepare = tools.withPreparedEmbeddedGatewayTools;
        const captureSource = vi
          .spyOn(tools, "withPreparedEmbeddedGatewayTools")
          .mockImplementation((attempt, run) =>
            prepare(attempt, async () => {
              if (attempt.sessionKey === sessionKey && !originalSource) {
                originalSource = await captureOperatorToolGatewayContinuationContext({
                  sessionKey,
                  agentId: "main",
                });
              }
              return run();
            }),
          );
        try {
          await client.request("chat.send", {
            sessionKey,
            sessionId,
            message: "Summarize the child finding.",
            deliver: false,
            idempotencyKey: warmupRunId,
          });
          await expect(
            client.request("agent.wait", { runId: warmupRunId, timeoutMs: 30_000 }),
          ).resolves.toMatchObject({ status: "ok" });
          // Completion custody intentionally outlives the original request's effects.
          await execution.waitForDispatch(warmupRunId);
        } finally {
          captureSource.mockRestore();
        }
        expect(originalSource?.operatorAuthority).toBeDefined();
        const registry = Reflect.get(
          globalThis,
          Symbol.for("openclaw.subagentRegistryTestApi"),
        ) as {
          resetSubagentRegistryForTests(options: { persist: false }): Promise<void>;
        };
        await registry.resetSubagentRegistryForTests({ persist: false });
        const parent = loadSessionEntryReadOnly(scope);
        if (!parent || !gatewayContext) {
          throw new Error("Missing requester");
        }
        const child = createSubagentRunRecord({
          runId: childId,
          childSessionKey: "agent:main:subagent:" + childId,
          childAgentId: "main",
          childSessionIdentity: { sessionId: "conflict-child-session" },
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterStorePath: resolvePhysicalSessionStorePath(scope),
          completionRequesterSessionId: parent.sessionId,
          completionRequesterLifecycleRevision: parent.lifecycleRevision,
          expectsCompletionMessage: true,
          cleanupHandled: true,
          cleanupCompletedAt: Date.now(),
          completion: {
            required: true,
            resultText: childText,
            terminalReply: { disposition: "visible", text: childText },
          },
          delivery: { status: "pending" },
          execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            batchRunIds: [childId],
            requesterYieldBatch: true,
            afterRequesterYield: true,
            rearmGeneration: 1,
          },
        });
        const childScope = {
          agentId: "main",
          sessionKey: child.childSessionKey,
          sessionId: "conflict-child-session",
          storePath,
        };
        await replaceSessionEntry(childScope, {
          sessionId: childScope.sessionId,
          updatedAt: Date.now(),
        });
        await persistSessionTranscriptTurn(childScope, {
          config: cfg,
          runId: childId,
          expectedSessionId: childScope.sessionId,
          touchSessionEntry: false,
          updateMode: "none",
          messages: [
            {
              message: {
                role: "assistant",
                phase: "final_answer",
                stopReason: "stop",
                content: [{ type: "text", text: childText }],
              },
            },
          ],
        });
        await mutateSubagentRuns([childId], () => ({
          value: undefined,
          postimages: new Map([[childId, child]]),
        }));
        const saved = subagentRuns.get(childId);
        if (!saved) {
          throw new Error("Missing durable child");
        }
        bindGatewayContextResolver(saved, () => gatewayContext);
        if (!originalSource) {
          throw new Error("Original requester authority was not captured");
        }
        subagentRuns.bindCompletionAuthority(saved, originalSource);
        const currentBatch = (batch: readonly SubagentRunRecord[]) =>
          batch.map((member) => {
            const current = subagentRuns.get(member.runId);
            if (
              !current ||
              !isSameSubagentRun(current, member) ||
              current.requesterSettleWake?.rearmGeneration !==
                member.requesterSettleWake?.rearmGeneration
            ) {
              throw new Error("Saved batch owner changed");
            }
            return current;
          });
        const wakeSavedBatch = (entry: SubagentRunRecord) =>
          maybeWakeRequesterAfterAllChildrenSettled({
            signal,
            isSourceCurrent: () => isSameSubagentRun(subagentRuns.get(childId), entry),
            requesterSessionKey: sessionKey,
            settledEntry: entry,
            transitionBatch: async (batch, next, onPublished) => {
              const result = await mutateRequesterCompletionBatch({
                entries: batch,
                operation: { kind: "transition", state: next },
                context: captureOpenClawStateWorkerContext(),
                assertCurrent: () => {
                  currentBatch(batch);
                },
                onCommitted: () => {},
                onPublished: () => {
                  // Revalidate custody even when the caller does not observe publication.
                  const current = currentBatch(batch);
                  onPublished?.(current);
                },
              });
              expect(result.publication).toBe("published");
            },
            completeBatch: async (batch, rearmGeneration, outcome, onCommitted) => {
              const result = await mutateRequesterCompletionBatch({
                entries: batch,
                operation: outcome ? { kind: "settle", outcome } : { kind: "complete" },
                assertCurrent: () => {
                  if (
                    !batch.every((member) => {
                      const current = subagentRuns.get(member.runId);
                      return (
                        isSameSubagentRun(current, member) &&
                        current?.requesterSettleWake?.rearmGeneration === rearmGeneration
                      );
                    })
                  ) {
                    throw new SubagentCompletionSourceChangedError(
                      "Subagent completion owner changed before settlement",
                    );
                  }
                },
              });
              expect(result.publication).toBe("published");
              await onCommitted?.();
            },
          });

        const transcriptText = () => JSON.stringify(loadTranscriptEventsSync(scope));
        const childTranscript = () => JSON.stringify(loadTranscriptEventsSync(childScope));
        const completedChildTranscript = childTranscript();
        expect(completedChildTranscript.split(childText)).toHaveLength(2);
        const readChild = () => loadSubagentRegistryFromSqlite().get(childId);
        const expectDelivery = (status: "delivered" | "failed") => {
          const persisted = readChild();
          expect(persisted?.requesterSettleWake).toBeUndefined();
          expect(persisted?.delivery?.status).toBe(status);
          if (status === "failed") {
            expect(persisted?.suppressCompletionDelivery).toBe(true);
          }
        };
        const expectNoRetry = async (count: number) => {
          expect(synthesisCount).toBe(count);
          expect(await wakeSavedBatch(subagentRuns.get(childId)!)).toBe(false);
          expect(synthesisCount).toBe(count);
        };
        const makeRetryDue = async () => {
          const current = subagentRuns.get(childId);
          if (!current?.requesterSettleWake) {
            throw new Error("Missing pending completion");
          }
          const result = await mutateRequesterCompletionBatch({
            entries: [current],
            operation: {
              kind: "transition",
              state: { ...current.requesterSettleWake, nextAttemptAt: 0 },
            },
            assertCurrent: () => {
              currentBatch([current]);
            },
          });
          expect(result.publication).toBe("published");
          return subagentRuns.get(childId)!;
        };
        const startSynthesis = async (entry: SubagentRunRecord) => {
          started = createDeferred();
          release = createDeferred();
          expectSynthesis = true;
          wake = wakeSavedBatch(entry);
          await withinTest(
            awaitGateBeforeSettlement(
              started.promise,
              wake,
              "Requester completion settled before model execution",
            ),
            signal,
          );
        };
        const sendHuman = async (index: number, queueMode: "followup" | "steer") => {
          const runId = "fixture-human-" + scenario + "-" + index;
          await expect(
            client.request("chat.send", {
              sessionKey,
              sessionId,
              message: humanText + index,
              deliver: false,
              queueMode,
              idempotencyKey: runId,
            }),
          ).resolves.toMatchObject({ status: "started" });
          // Acceptance may queue the input behind the held completion. Do not
          // await execution until that completion has been released.
          return runId;
        };
        const waitForHuman = async (runId: string) => {
          await vi.waitFor(
            async () =>
              expect(await client.request("agent.wait", { runId, timeoutMs: 0 })).toMatchObject({
                status: "ok",
              }),
            { timeout: 30_000 },
          );
        };
        await startSynthesis(saved);
        if (scenario === "replaced") {
          // Commit a replacement incarnation through the session owner while the
          // old turn is held. Its original completion custody must not transfer.
          await replaceSessionEntry(scope, {
            ...loadSessionEntryReadOnly(scope),
            sessionId: "replacement-parent",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: Date.now(),
          });
          release.resolve();
          expect(await wake).toBe(false);
          expect(transcriptText()).not.toContain("Requester synthesis 1.");
          expect(childTranscript()).toBe(completedChildTranscript);
          expect(readChild()?.requesterSettleWake).toBeUndefined();
          await expectNoRetry(1);
          return;
        }
        if (scenario === "revoked") {
          // Retire the actual Gateway source owner, including grants retained by the run.
          closeGatewayDeviceRevocation(gatewayContext);
          release.resolve();
          expect(await wake).toBe(false);
          expect(transcriptText()).not.toContain("Requester synthesis ");
          expect(childTranscript()).toBe(completedChildTranscript);
          expect(readChild()?.delivery?.status).not.toBe("delivered");
          await expectNoRetry(1);
          return;
        }
        if (scenario === "effect") {
          expect(await readFile(path.join(state.workspaceDir, "effect.txt"), "utf8")).toBe(
            "One committed private effect.",
          );
        }
        if (scenario === "send") {
          expect(sentTexts).toEqual(["One committed message."]);
        }
        const conflictCount = scenario === "exhaust" ? 3 : 1;
        for (let index = 1; index <= conflictCount; index++) {
          const mode = scenario === "steer" ? "steer" : "followup";
          const conflict =
            scenario === "conflict" ||
            scenario === "exhaust" ||
            scenario === "effect" ||
            scenario === "send";
          const humanRun = index === 1 ? await sendHuman(index, mode) : undefined;
          // Ordinary input uses the real Gateway, but its authority differs from
          // this system turn, so even steer queues it until synthesis settles.
          expect(transcriptText()).not.toContain(humanText + index);
          if (conflict) {
            // A separate committed writer invalidates the prepared transcript.
            // Use the actual SQLite owner, not a thrown/mocked conflict. This
            // does not identify the incident's unproved competing writer.
            await appendTranscriptMessage(scope, {
              message: { role: "user", content: concurrentText + index },
            });
            expect(transcriptText()).toContain(concurrentText + index);
          }
          release.resolve();
          const delivered = await wake;
          if (humanRun) {
            await waitForHuman(humanRun);
          }
          expect(childTranscript()).toBe(completedChildTranscript);
          if (humanRun) {
            expect(transcriptText()).toContain(humanText + index);
          }
          if (!conflict) {
            expect(delivered).toBe(true);
            expect(transcriptText().split("Requester synthesis 1.")).toHaveLength(2);
            expectDelivery("delivered");
            return;
          }
          expect(delivered).toBe(false);
          expect(transcriptText()).toContain(concurrentText + index);
          expect(transcriptText()).not.toContain("Requester synthesis ");
          if (scenario === "effect" || scenario === "send") {
            expectDelivery("failed");
            expect(effectCalls).toBe(1);
            expect(sentTexts).toEqual(scenario === "send" ? ["One committed message."] : []);
            await expectNoRetry(1);
            return;
          }
          if (index === 3) {
            expectDelivery("failed");
            expect(readChild()?.delivery).toMatchObject({
              status: "failed",
              lastError: "requester_transcript_conflict",
            });
            expect(synthesisCount).toBe(3);
            return;
          }
          expect(readChild()?.requesterSettleWake).toMatchObject({
            status: "pending",
            attemptCount: index,
          });
          expect(readChild()?.requesterSettleWake?.nextAttemptAt).toBeGreaterThan(Date.now());
          await startSynthesis(await makeRetryDue());
        }
        // A fresh admission observes the newer human input; the rejected answer is never rebased.
        expect(synthesisBodies[1]).toContain(humanText + 1);
        release.resolve();
        expect(await wake).toBe(true);
        expect(transcriptText()).not.toContain("Requester synthesis 1.");
        expect(transcriptText().split("Requester synthesis 2.")).toHaveLength(2);
        expectDelivery("delivered");
        expect(childTranscript()).toBe(completedChildTranscript);
        await expectNoRetry(2);
      } finally {
        release.resolve();
        if (wake) {
          await Promise.allSettled([wake]);
        }
        clearFollowupQueue(sessionKey);
        originalSource?.release();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer.listening) {
          await closeHttpServer(providerServer);
        }
        await execution?.restore();
        subagentRuns.delete(childId);
        await state.cleanup();
      }
    },
  );
}
