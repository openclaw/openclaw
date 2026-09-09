import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { emitAgentEvent, onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import type { startGatewayMaintenanceTimers } from "../server-maintenance.js";
import { loadSessionEntry } from "../session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

// Observe the existing owner boundary without replacing its implementation.
// Capture the installed sweep for deterministic invocation; keep its real timer.
// RPC admission, expiry, abort, persistence, and model HTTP requests run normally.
const maintenance = vi.hoisted(() => ({
  params: undefined as Parameters<typeof startGatewayMaintenanceTimers>[0] | undefined,
  sweep: undefined as (() => void) | undefined,
}));
vi.mock("../server-maintenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-maintenance.js")>();
  return {
    ...actual,
    startGatewayMaintenanceTimers: (...args: Parameters<typeof startGatewayMaintenanceTimers>) => {
      maintenance.params = args[0];
      const realSetInterval = globalThis.setInterval;
      const timer = vi
        .spyOn(globalThis, "setInterval")
        .mockImplementation((callback, delay, ...rest) => {
          if (delay === 60_000) {
            maintenance.sweep = () => callback(...rest);
          }
          return realSetInterval(callback, delay, ...rest);
        });
      try {
        return actual.startGatewayMaintenanceTimers(...args);
      } finally {
        timer.mockRestore();
      }
    },
  };
});

// Hold before the existing report transaction. Neither half of the timeout
// outcome may reach durable history before the combined report commits.
const concurrentTurn = vi.hoisted(() => ({
  beforeReport: undefined as (() => Promise<void>) | undefined,
  onAdmission: undefined as (() => void) | undefined,
}));
vi.mock("../../sessions/session-run-error.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-run-error.js")>();
  return {
    ...actual,
    recordGatewaySessionRunFailure: async (
      ...args: Parameters<typeof actual.recordGatewaySessionRunFailure>
    ) => {
      if (args[0].runId === "timeout-proof-partial-timeout") {
        await concurrentTurn.beforeReport?.();
      }
      return actual.recordGatewaySessionRunFailure(...args);
    },
  };
});
vi.mock("./chat-send-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-send-admission.js")>();
  return {
    ...actual,
    admitChatSend: (...args: Parameters<typeof actual.admitChatSend>) => {
      if (args[0].session.clientRunId === "timeout-proof-next-partial-timeout") {
        concurrentTurn.onAdmission?.();
      }
      return actual.admitChatSend(...args);
    },
  };
});

const NOTICE = "This turn timed out and may have performed work before it stopped.";
const PARTIAL = "TIMEOUT_PROOF_PARTIAL_OUTPUT";
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
  | "duplicate-timeout";
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
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const requests: CapturedRequest[] = [];
      const lifecycle: AgentEventPayload[] = [];
      const chatEvents: Array<Record<string, unknown>> = [];
      let scenario: Scenario = "empty-timeout";
      let nextTurn = false;
      const reportReady = createDeferred();
      const releaseReport = createDeferred();
      const nextAdmission = createDeferred();
      const concurrentProviderRequest = createDeferred<Record<string, unknown>>();
      let reportGateReleased = false;
      concurrentTurn.beforeReport = async () => {
        reportReady.resolve();
        await releaseReport.promise;
      };
      concurrentTurn.onAdmission = () => nextAdmission.resolve();
      const unsubscribe = onAgentEvent((event) => {
        if (event.stream === "lifecycle") {
          lifecycle.push(event);
        }
      });
      try {
        const tempHome = tempDirs.make("openclaw-timeout-history-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspace = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all(
          [stateDir, workspace, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
        );
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
            requests.push({ body, response });
            if (scenario === "partial-timeout" && nextTurn && !reportGateReleased) {
              concurrentProviderRequest.resolve(body);
            }
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
                  delta: PARTIAL,
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
              entries: { main: { default: true } },
            },
            models: {
              mode: "replace",
              providers: { [provider.providerId]: { ...provider.config, timeoutSeconds: 120 } },
            },
            gateway: { auth: { mode: "token", token: "timeout-history-proof-token" } },
          },
          onEvent: (event) => {
            if (event.event === "chat" && event.payload && typeof event.payload === "object") {
              chatEvents.push(event.payload as Record<string, unknown>);
            }
          },
        });
        await expect.poll(() => maintenance.params, { timeout: 20_000 }).toBeDefined();
        const verdicts: unknown[] = [];
        for (const current of [
          "empty-timeout",
          "partial-timeout",
          "user-cancel",
          "normal",
          "duplicate-timeout",
        ] as const) {
          scenario = current;
          nextTurn = false;
          const sessionKey = `agent:main:timeout-proof-${current}`;
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
          await expect
            .poll(() => requests.length, { timeout: 20_000 })
            .toBeGreaterThan(requestStart);
          const isTimeout = current.endsWith("timeout");
          let earlyContinued: Promise<{ runId: string }> | undefined;
          let earlyNextRequestStart: number | undefined;
          let requestBeforeReportRelease: Record<string, unknown> | undefined;
          let reportGateReached: boolean | undefined;
          if (current === "partial-timeout") {
            await expect
              .poll(() => maintenance.params?.chatRunState.runs.get(started.runId)?.buffer, {
                timeout: 10_000,
              })
              .toContain(PARTIAL);
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
            maintenance.sweep();
            // Deadline emission installs the owner in this same synchronous
            // stack, before any next RPC or microtask can read the transcript.
            expect(entry.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
            await expect
              .poll(
                () =>
                  lifecycle.some(
                    (event) =>
                      event.runId === started.runId &&
                      event.data.stopReason === "timeout" &&
                      event.data.aborted === true,
                  ),
                { timeout: 10_000 },
              )
              .toBe(true);
          } else if (current === "user-cancel") {
            const aborted = await gateway.client.request<{ aborted: boolean }>("chat.abort", {
              sessionKey,
              runId: started.runId,
            });
            expect(aborted.aborted).toBe(true);
          }
          if (current === "partial-timeout") {
            reportGateReached = await Promise.race([
              reportReady.promise.then(() => true),
              sleep(10_000, false, { ref: false }),
            ]);
            expect
              .soft(reportGateReached, "timeout report must reach its persistence gate")
              .toBe(true);
            if (reportGateReached) {
              const transcriptBeforeCommit = await transcriptFor(sessionKey);
              expect.soft(JSON.stringify(transcriptBeforeCommit)).not.toContain(PARTIAL);
              expect.soft(JSON.stringify(transcriptBeforeCommit)).not.toContain(NOTICE);
              expect(reportRows(transcriptBeforeCommit)).toHaveLength(0);
              nextTurn = true;
              earlyNextRequestStart = requests.length;
              earlyContinued = gateway.client.request<{ runId: string }>("chat.send", {
                sessionKey,
                message: "Continue from the previous turn.",
                deliver: false,
                idempotencyKey: `timeout-proof-next-${current}`,
              });
              // Observe real admission before the bounded absence check. A network
              // request that has not reached the Gateway cannot satisfy this proof.
              void earlyContinued.catch(() => {});
              await nextAdmission.promise;
              requestBeforeReportRelease = await Promise.race([
                concurrentProviderRequest.promise,
                sleep(5_000).then(() => undefined),
              ]);
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
            } else {
              console.info(
                `TIMEOUT_CONCURRENT_ADMISSION ${JSON.stringify({ scenario: current, reportGateReached: false, admissionReached: false, concurrentProbeSkipped: "report persistence gate not reached within 10000ms" })}`,
              );
            }
            reportGateReleased = true;
            releaseReport.resolve();
          }
          await expect
            .poll(() => maintenance.params?.chatAbortControllers.has(started.runId), {
              timeout: 20_000,
            })
            .toBe(false);
          await gateway.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 20_000 },
            { timeoutMs: 25_000 },
          );
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
            expect.soft(timeoutReport).toEqual([
              expect.objectContaining({
                content: expect.stringContaining(JSON.stringify(PARTIAL)),
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
          await expect
            .poll(() => requests.length, { timeout: 20_000 })
            .toBeGreaterThan(nextRequestStart);
          const modelInput = JSON.stringify(requests[nextRequestStart]?.body);
          console.info(
            `TIMEOUT_HISTORY_CASE ${JSON.stringify({ scenario: current, acceleration: isTimeout ? "registered expiresAtMs set to past; real maintenance callback invoked" : "none", transcript: firstTranscript, history: firstHistory, nextProviderRequest: requests[nextRequestStart]?.body })}`,
          );
          expect.soft(modelInput.includes(NOTICE)).toBe(isTimeout);
          expect.soft(modelInput).not.toContain("This turn did not run");
          if (current === "partial-timeout") {
            expect.soft(modelInput.includes(PARTIAL)).toBe(true);
          }
          if (current === "normal") {
            expect.soft(modelInput.includes(COMPLETE)).toBe(true);
          }
          await gateway.client.request(
            "agent.wait",
            { runId: continued.runId, timeoutMs: 20_000 },
            { timeoutMs: 25_000 },
          );
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
      } finally {
        releaseReport.resolve();
        concurrentTurn.beforeReport = undefined;
        concurrentTurn.onAdmission = undefined;
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
