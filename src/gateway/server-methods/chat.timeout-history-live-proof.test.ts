import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { emitAgentEvent, onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import type { startGatewayMaintenanceTimers } from "../server-maintenance.js";
import { loadSessionEntry } from "../session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

// Observe the existing owner boundary without replacing its implementation.
// Drive the registered deadline sweep directly; unrelated periodic jobs stay idle.
// RPC admission, expiry, abort, persistence, and model HTTP requests run normally.
const maintenance = vi.hoisted(() => ({
  params: undefined as Parameters<typeof startGatewayMaintenanceTimers>[0] | undefined,
  sweep: undefined as (() => void | Promise<unknown>) | undefined,
  onStarted: undefined as (() => void) | undefined,
}));
vi.mock("../server-maintenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-maintenance.js")>();
  return {
    ...actual,
    startGatewayMaintenanceTimers: (...args: Parameters<typeof startGatewayMaintenanceTimers>) => {
      maintenance.params = args[0];
      const scheduler = args[0].scheduler;
      const createScope = scheduler.scope.bind(scheduler);
      const schedulingSpies: Array<{ mockRestore: () => void }> = [];
      const scoping = vi.spyOn(scheduler, "scope").mockImplementation(() => {
        const scope = createScope();
        const schedule = scope.schedule.bind(scope);
        schedulingSpies.push(
          vi.spyOn(scope, "schedule").mockImplementation((job) => {
            if (job.id === "maintenance:dedupe") {
              maintenance.sweep = job.run;
            }
            return schedule(job);
          }),
        );
        return scope;
      });
      try {
        const result = actual.startGatewayMaintenanceTimers(...args);
        maintenance.onStarted?.();
        return result;
      } finally {
        scoping.mockRestore();
        for (const scheduling of schedulingSpies) {
          scheduling.mockRestore();
        }
      }
    },
  };
});

// Hold before the existing report transaction. Neither half of the timeout
// outcome may reach durable history before the combined report commits.
const concurrentTurn = vi.hoisted(() => ({
  reportRunId: undefined as string | undefined,
  beforeReport: undefined as (() => Promise<void>) | undefined,
  onTimeoutWait: undefined as ((runId: string) => void) | undefined,
}));
vi.mock("../../sessions/session-run-error.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-run-error.js")>();
  return {
    ...actual,
    recordGatewaySessionRunFailure: async (
      ...args: Parameters<typeof actual.recordGatewaySessionRunFailure>
    ) => {
      if (concurrentTurn.reportRunId && args[0].runId === concurrentTurn.reportRunId) {
        await concurrentTurn.beforeReport?.();
      }
      return actual.recordGatewaySessionRunFailure(...args);
    },
  };
});
vi.mock("./chat-send-timeout-persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-send-timeout-persistence.js")>();
  return {
    ...actual,
    waitForChatSessionTimeoutPersistence: (
      ...args: Parameters<typeof actual.waitForChatSessionTimeoutPersistence>
    ) => {
      const operation = actual.waitForChatSessionTimeoutPersistence(...args);
      concurrentTurn.onTimeoutWait?.(args[0].session.clientRunId);
      return operation;
    },
  };
});

const NOTICE = "This turn timed out and may have performed work before it stopped.";
const PARTIAL = "TIMEOUT_PROOF_PARTIAL_OUTPUT";
const CREDENTIAL = "sk-" + "synthetic-timeout-live-credential-".repeat(3);
const COMPLETE = "TIMEOUT_PROOF_COMPLETED_OUTPUT";
const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Scenario =
  | "empty-timeout"
  | "partial-timeout"
  | "user-cancel"
  | "normal"
  | "duplicate-timeout"
  | "persistence-failure-timeout";
type CapturedRequest = { body: Record<string, unknown>; response: ServerResponse };

function reportRows(events: readonly unknown[]) {
  return events.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { customType?: string }).customType === "run-failed-before-reply",
  );
}

async function transcriptFor(sessionKey: string) {
  const loaded = loadSessionEntry(sessionKey);
  if (!loaded.entry?.sessionId) {
    throw new Error("Gateway has not persisted the session identity");
  }
  return loadTranscriptEvents({
    agentId: loaded.agentId,
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  });
}

describe("deadline outcome real Gateway history proof", () => {
  it(
    "persists terminal facts and includes them in the next provider request",
    { timeout: 150_000 },
    async ({ signal }) => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const requests: CapturedRequest[] = [];
      const lifecycle: AgentEventPayload[] = [];
      const requestWaiters = new Map<number, (request: CapturedRequest) => void>();
      const timedOutRuns = new Set<string>();
      const timeoutWaiters = new Map<string, () => void>();
      const maintenanceStarted = createDeferred();
      const partialVisible = createDeferred();
      maintenance.onStarted = () => maintenanceStarted.resolve();
      const waitForProviderRequest = (index: number): Promise<CapturedRequest> => {
        const received = requests[index];
        if (received) {
          return Promise.resolve(received);
        }
        const pending = createDeferred<CapturedRequest>();
        requestWaiters.set(index, pending.resolve);
        return withinTest(pending.promise, signal);
      };
      const waitForTimeout = (runId: string): Promise<void> => {
        if (timedOutRuns.has(runId)) {
          return Promise.resolve();
        }
        const pending = createDeferred();
        timeoutWaiters.set(runId, pending.resolve);
        return withinTest(pending.promise, signal);
      };
      const waitForRunRemoval = async (runId: string) => {
        const entries = maintenance.params?.chatAbortControllers;
        if (!entries) {
          throw new Error("Gateway maintenance has not started");
        }
        const entry = entries.get(runId);
        if (entry) {
          await waitForChatAbortControllerRemoval({
            entries,
            targets: [{ runId, entry }],
            timeoutMs: null,
            signal,
          });
        }
        expect(entries.has(runId)).toBe(false);
      };
      const chatEvents: Array<Record<string, unknown>> = [];
      let scenario: Scenario = "empty-timeout";
      let nextTurn = false;
      let releaseHeldReport: (() => void) | undefined;
      const unsubscribe = onAgentEvent((event) => {
        if (event.stream === "lifecycle") {
          lifecycle.push(event);
          if (event.data.stopReason === "timeout" && event.data.aborted === true) {
            timedOutRuns.add(event.runId);
            timeoutWaiters.get(event.runId)?.();
            timeoutWaiters.delete(event.runId);
          }
        }
      });
      try {
        const tempHome = tempDirs.make("openclaw-timeout-history-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspace = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        const databasePath = path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        );
        const databaseInput = process.env.OPENCLAW_TIMEOUT_HISTORY_PROOF_DATABASE;
        const databaseOutput = process.env.OPENCLAW_TIMEOUT_HISTORY_PROOF_DATABASE_OUTPUT;
        await Promise.all(
          [stateDir, workspace, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
        );
        // An opt-in cross-version run supplies a closed, migrated database made
        // by the older release's real session writer. Routine CI starts empty.
        if (databaseInput) {
          await fs.mkdir(path.dirname(databasePath), { recursive: true });
          await fs.copyFile(databaseInput, databasePath);
        }
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "timeout-history-proof-token",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        })) {
          setTestEnvValue(key, value);
        }
        providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >;
            const index = requests.length;
            const captured = { body, response };
            requests.push(captured);
            requestWaiters.get(index)?.(captured);
            requestWaiters.delete(index);
            if (nextTurn || scenario === "normal") {
              writeOpenAiResponsesText(response, {
                text: COMPLETE,
                messageId: `message-${requests.length}`,
                responseId: `response-${requests.length}`,
              });
              return;
            }
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
            response.flushHeaders();
            if (scenario === "partial-timeout") {
              const item = {
                type: "message",
                id: "partial-message",
                role: "assistant",
                status: "in_progress",
                content: [],
              };
              for (const event of [
                { type: "response.output_item.added", output_index: 0, item },
                {
                  type: "response.content_part.added",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                },
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  delta: `${PARTIAL}\napi_key=${CREDENTIAL}`,
                },
              ]) {
                response.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
            // The provider remains open. The Gateway's registered-run expiry owns termination.
          })().catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
        gateway = await startGatewayWithClient({
          configPath,
          token: "timeout-history-proof-token",
          cfg: {
            plugins: { enabled: false },
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                timeoutSeconds: 120,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
              entries: { main: {} },
            },
            models: {
              mode: "replace",
              providers: { [provider.providerId]: { ...provider.config, timeoutSeconds: 120 } },
            },
            gateway: { auth: { mode: "token", token: "timeout-history-proof-token" } },
          },
          onEvent: (event) => {
            if (event.event === "chat" && event.payload && typeof event.payload === "object") {
              const payload = event.payload as Record<string, unknown>;
              chatEvents.push(payload);
              if (
                payload.runId === "timeout-proof-partial-timeout" &&
                JSON.stringify(payload).includes(PARTIAL)
              ) {
                partialVisible.resolve();
              }
            }
          },
        });
        await withinTest(maintenanceStarted.promise, signal);
        expect(maintenance.params).toBeDefined();
        const verdicts: unknown[] = [];
        for (const current of [
          "empty-timeout",
          "partial-timeout",
          "user-cancel",
          "normal",
          "duplicate-timeout",
          "persistence-failure-timeout",
        ] as const) {
          scenario = current;
          nextTurn = false;
          const sessionKey = `agent:main:timeout-proof-${current}`;
          const holdReport =
            current === "partial-timeout" || current === "persistence-failure-timeout";
          const reportReady = createDeferred();
          const releaseReport = createDeferred();
          const timeoutWaitCalled = createDeferred<"wait-called">();
          releaseHeldReport = () => releaseReport.resolve();
          concurrentTurn.reportRunId = holdReport ? `timeout-proof-${current}` : undefined;
          concurrentTurn.beforeReport = async () => {
            reportReady.resolve();
            await releaseReport.promise;
          };
          concurrentTurn.onTimeoutWait = (runId) => {
            if (runId === `timeout-proof-next-${current}`) {
              timeoutWaitCalled.resolve("wait-called");
            }
          };
          const requestStart = requests.length;
          const started = await gateway.client.request<{ runId: string; status: string }>(
            "chat.send",
            {
              sessionKey,
              message: `First turn for ${current}.`,
              deliver: false,
              idempotencyKey: `timeout-proof-${current}`,
            },
          );
          expect(started.status).toBe("started");
          await waitForProviderRequest(requestStart);
          const isTimeout = current.endsWith("timeout");
          let earlyContinued: Promise<{ runId: string }> | undefined;
          let earlyNextRequestStart: number | undefined;
          let requestBeforeReportRelease: Record<string, unknown> | undefined;
          let reportGateReached: boolean | undefined;
          let terminalPersistence: Promise<void> | undefined;
          if (current === "partial-timeout") {
            await withinTest(partialVisible.promise, signal);
            expect(maintenance.params?.chatRunState.runs.get(started.runId)?.buffer).toContain(
              PARTIAL,
            );
          }
          if (isTimeout) {
            const entry = maintenance.params?.chatAbortControllers.get(started.runId);
            expect(entry).toBeDefined();
            if (!entry) {
              throw new Error("real RPC run was not registered for maintenance");
            }
            entry.expiresAtMs = Date.now() - 1;
            if (!maintenance.sweep) {
              throw new Error("Gateway maintenance sweep was not installed");
            }
            void maintenance.sweep();
            expect(entry.controller.signal.aborted).toBe(true);
            expect(entry.abortStopReason).toBe("timeout");
            // Deadline emission installs the owner in this same synchronous
            // stack, before any next RPC or microtask can read the transcript.
            expect(entry.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
            terminalPersistence = entry.projectSessionTerminalPersistence;
            await waitForTimeout(started.runId);
          } else if (current === "user-cancel") {
            const aborted = await gateway.client.request<{ aborted: boolean }>("chat.abort", {
              sessionKey,
              runId: started.runId,
            });
            expect(aborted.aborted).toBe(true);
          }
          if (holdReport) {
            if (!terminalPersistence) {
              throw new Error("timeout report has no persistence owner");
            }
            await withinTest(
              awaitGateBeforeSettlement(
                reportReady.promise,
                terminalPersistence,
                "timeout persistence settled without reaching its report gate",
              ),
              signal,
            );
            reportGateReached = true;
            const transcriptBeforeCommit = await transcriptFor(sessionKey);
            expect.soft(JSON.stringify(transcriptBeforeCommit)).not.toContain(PARTIAL);
            expect.soft(JSON.stringify(transcriptBeforeCommit)).not.toContain(NOTICE);
            expect(reportRows(transcriptBeforeCommit)).toHaveLength(0);
            expect(
              maintenance.params?.chatAbortControllers.get(started.runId)
                ?.projectSessionTerminalPersistence,
            ).toBe(terminalPersistence);
            nextTurn = true;
            earlyNextRequestStart = requests.length;
            earlyContinued = gateway.client.request<{ runId: string }>("chat.send", {
              sessionKey,
              message: "Continue from the previous turn.",
              deliver: false,
              idempotencyKey: `timeout-proof-next-${current}`,
            });
            // This callback is a scheduling barrier. The failure scenario below
            // proves the awaited dependency through the actual RPC result.
            void earlyContinued.catch(() => {});
            const reached = await withinTest(
              awaitGateBeforeSettlement(
                timeoutWaitCalled.promise,
                earlyContinued,
                "next turn did not call the timeout persistence wait",
              ),
              signal,
            );
            expect(reached).toBe("wait-called");
            requestBeforeReportRelease = requests[earlyNextRequestStart]?.body;
            console.info(
              `TIMEOUT_CONCURRENT_ADMISSION ${JSON.stringify({
                scenario: current,
                admissionReached: true,
                transcriptBeforeCommit,
                gateReleased: false,
                providerRequestBeforeRelease: requestBeforeReportRelease ?? null,
                providerRequestHasTimeout: requestBeforeReportRelease
                  ? JSON.stringify(requestBeforeReportRelease).includes(NOTICE)
                  : null,
              })}`,
            );
            expect.soft(requestBeforeReportRelease).toBeUndefined();
            if (current === "persistence-failure-timeout") {
              const failure = new Error("timeout history proof report write failed");
              releaseReport.reject(failure);
              await expect(withinTest(earlyContinued, signal)).rejects.toMatchObject({
                name: "GatewayClientRequestError",
                gatewayCode: "INVALID_REQUEST",
                message: `Error: ${failure.message}`,
              });
              await expect(withinTest(terminalPersistence, signal)).rejects.toBe(failure);
            } else {
              releaseReport.resolve();
            }
          }
          await waitForRunRemoval(started.runId);
          if (current === "duplicate-timeout") {
            const terminal = lifecycle.find(
              (event) =>
                event.runId === started.runId &&
                event.data.stopReason === "timeout" &&
                event.data.aborted === true,
            );
            if (!terminal) {
              throw new Error("maintenance timeout did not emit its terminal event");
            }
            emitAgentEvent({ ...terminal });
            emitAgentEvent({ ...terminal });
          }
          const firstTranscript = await transcriptFor(sessionKey);
          if (current === "persistence-failure-timeout") {
            expect(reportRows(firstTranscript)).toHaveLength(0);
            expect(JSON.stringify(firstTranscript)).not.toContain(NOTICE);
            expect(requests.length).toBe(earlyNextRequestStart);
            expect(
              maintenance.params?.chatAbortControllers.has(`timeout-proof-next-${current}`),
            ).toBe(false);
            verdicts.push({
              scenario: current,
              reportGateReached,
              reportFailurePropagated: true,
              durableTimeoutReports: 0,
              successorProviderRequests: 0,
            });
            continue;
          }
          const firstHistory = await gateway.client.request<{
            messages: unknown[];
            sessionInfo?: { status?: string };
          }>("chat.history", { sessionKey, limit: 100 });
          expect.soft(reportRows(firstTranscript)).toHaveLength(isTimeout ? 1 : 0);
          // Canonical transcript and the provider request below are the
          // persistence/replay proof; also capture the current UI projection.
          // The concurrent case can already project the successor's state.
          if (current !== "partial-timeout") {
            expect
              .soft(firstHistory.sessionInfo?.status)
              .toBe(isTimeout ? "timeout" : current === "user-cancel" ? "killed" : "done");
          }
          if (current === "partial-timeout") {
            // A single existing custom report carries both facts. A separate
            // injected assistant entry would recreate the crash/downgrade gap.
            const timeoutReport = reportRows(firstTranscript);
            expect.soft(JSON.stringify(timeoutReport)).toContain(PARTIAL);
            expect.soft(JSON.stringify(timeoutReport)).toContain(NOTICE);
            expect.soft(JSON.stringify(firstTranscript)).not.toContain(CREDENTIAL);
            expect.soft(JSON.stringify(firstHistory)).not.toContain(CREDENTIAL);
            expect.soft(timeoutReport).toEqual([
              expect.objectContaining({
                content: expect.stringContaining(`\n"${PARTIAL}\\napi_key=`),
              }),
            ]);
            const entriesWithPartial = firstTranscript.filter((entry) =>
              JSON.stringify(entry).includes(PARTIAL),
            );
            expect.soft(entriesWithPartial).toHaveLength(1);
            expect.soft(entriesWithPartial).toEqual(timeoutReport);
          }
          if (current === "normal") {
            expect.soft(JSON.stringify(firstTranscript)).toContain(COMPLETE);
          }
          nextTurn = true;
          const nextRequestStart = earlyNextRequestStart ?? requests.length;
          const continued = await (earlyContinued ??
            gateway.client.request<{ runId: string }>("chat.send", {
              sessionKey,
              message: "Continue from the previous turn.",
              deliver: false,
              idempotencyKey: `timeout-proof-next-${current}`,
            }));
          await waitForProviderRequest(nextRequestStart);
          const modelInput = JSON.stringify(requests[nextRequestStart]?.body);
          console.info(
            `TIMEOUT_HISTORY_CASE ${JSON.stringify({ scenario: current, acceleration: isTimeout ? "registered expiresAtMs set to past; real maintenance callback invoked" : "none", transcript: firstTranscript, history: firstHistory, nextProviderRequest: requests[nextRequestStart]?.body })}`,
          );
          expect.soft(modelInput.includes(NOTICE)).toBe(isTimeout);
          expect.soft(modelInput).not.toContain("This turn did not run");
          if (databaseInput && (current === "empty-timeout" || current === "partial-timeout")) {
            const original = `DATABASE_COMPATIBILITY_ORIGINAL_${current}`;
            expect.soft(JSON.stringify(firstTranscript)).toContain(original);
            expect.soft(modelInput).toContain(original);
          }
          if (current === "partial-timeout") {
            expect.soft(modelInput.includes(PARTIAL)).toBe(true);
            expect.soft(modelInput).not.toContain(CREDENTIAL);
          }
          if (current === "normal") {
            expect.soft(modelInput.includes(COMPLETE)).toBe(true);
          }
          await waitForRunRemoval(continued.runId);
          expect.soft(reportRows(await transcriptFor(sessionKey))).toHaveLength(isTimeout ? 1 : 0);
          verdicts.push({
            scenario: current,
            reportGateReached,
            providerRequestBeforeReportRelease: reportGateReached
              ? requestBeforeReportRelease !== undefined
              : undefined,
            durableTimeoutReports: reportRows(firstTranscript).length,
            historyHasTimeout: JSON.stringify(firstHistory).includes(NOTICE),
            nextProviderRequestHasTimeout: modelInput.includes(NOTICE),
            partialPreserved:
              current === "partial-timeout" ? modelInput.includes(PARTIAL) : undefined,
            stopReasons: chatEvents
              .filter((event) => event.runId === started.runId)
              .map((event) => event.stopReason)
              .filter(Boolean),
          });
        }
        console.info(`TIMEOUT_HISTORY_VERDICT ${JSON.stringify(verdicts)}`);
        if (databaseOutput) {
          const { DatabaseSync, backup } = await import("node:sqlite");
          const database = new DatabaseSync(databasePath, { readOnly: true });
          try {
            await fs.mkdir(path.dirname(databaseOutput), { recursive: true });
            await backup(database, databaseOutput);
          } finally {
            database.close();
          }
        }
      } finally {
        releaseHeldReport?.();
        concurrentTurn.reportRunId = undefined;
        concurrentTurn.beforeReport = undefined;
        concurrentTurn.onTimeoutWait = undefined;
        unsubscribe();
        for (const request of requests) {
          request.response.destroy();
        }
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
            providerServer?.closeAllConnections();
          });
        }
        maintenance.params = undefined;
        maintenance.sweep = undefined;
        maintenance.onStarted = undefined;
        requestWaiters.clear();
        timeoutWaiters.clear();
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});
