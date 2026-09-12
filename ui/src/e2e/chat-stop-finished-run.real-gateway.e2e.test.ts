// Fault injection withholds only this run's terminal notifications; Stop must recover from the real Gateway's no-active-run answer.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { finished } from "node:stream/promises";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { SessionsListResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:stop-finished";
const replyText = "Finished reply from the fixture provider.";
type EventPayload = {
  sessionKey?: string;
  sessionId?: string;
  inFlightRun?: { runId: string };
  runId?: string;
  clientRunId?: string;
  lastRunId?: string | null;
  hasActiveRun?: boolean;
  status?: string;
  state?: string;
  phase?: string;
  stream?: string;
  data?: { phase?: string };
  session?: { lastRunId?: string | null; hasActiveRun?: boolean; status?: string };
  ok?: boolean;
  aborted?: boolean;
  runIds?: string[];
  sessionInfo?: {
    key?: string;
    sessionId?: string;
    hasActiveRun?: boolean;
    lastRunId?: string;
    status?: string;
  };
};
type Frame = {
  type: string;
  id?: string;
  ok?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  event?: string;
  seq?: number;
  payload?: EventPayload;
};
let artifactDir: string;
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
// This directory is eligible for CI upload; full traces and raw protocol proof belong to the private fixture.
const proof: Record<string, string | number | boolean> = { faultInjection: true };
async function startProvider() {
  const completion = createDeferred();
  const handlers = new Set<Promise<void>>();
  let requests = 0;
  let stopping = false;
  const server = createServer((request, response) => {
    const handler = (async () => {
      await finished(request.resume());
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      requests += 1;
      await completion.promise;
      if (stopping || response.destroyed) {
        response.destroy();
        return;
      }
      writeOpenAiResponsesText(response, {
        text: replyText,
        messageId: "fixture-message",
        responseId: "fixture-response",
      });
    })();
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      () => {
        proof.providerFailed = true;
        response.destroy();
        handlers.delete(handler);
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind a TCP port");
  }
  return {
    port: address.port,
    requests: () => requests,
    release() {
      proof.providerReleased = true;
      completion.resolve();
    },
    async stop() {
      stopping = true;
      completion.resolve();
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all(handlers);
      await closed;
      proof.providerStopped = !server.listening;
    },
  };
}

const suite = createControlUiE2eSuite({
  name: "Chat Stop after a real Gateway finished the run",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("stop-finished-run");
    provider = await startProvider();
    try {
      instance = await createOpenClawTestInstance({
        name: "stop-finished-run",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: { model: "stop-fixture/echo", modelPolicy: { allow: ["stop-fixture/*"] } },
            entries: { main: { identity: { name: "Stop fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "stop-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-unused-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                models: [{ id: "echo", name: "Echo" }],
              },
            },
          },
          plugins: { allow: [] },
        },
      });
      await instance.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        async close() {
          try {
            await instance.cleanup();
            proof.gatewayStopped = !instance.child;
          } finally {
            await provider.stop();
            await fs.writeFile(
              path.join(artifactDir, "proof.json"),
              JSON.stringify(proof, null, 2) + "\n",
            );
          }
        },
      };
    } catch (error) {
      try {
        await instance?.cleanup();
      } finally {
        await provider.stop();
      }
      throw error;
    }
  },
});

suite.define(() => {
  it("restores the composer after Stop targets a run the Gateway already finished", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const sent: Frame[] = [];
        const received: Frame[] = [];
        const delivered: Frame[] = [];
        const pending = new Map<string, Frame>();
        const knownRunIds = new Set<string>();
        let runId: string | undefined;
        let sockets = 0;
        let dropped = 0;
        let stage = "create session";
        const call = async (method: string, params: Record<string, unknown>) => {
          const args = ["gateway", "call", method, "--json", "--params", JSON.stringify(params)];
          const result = await instance.cli(args);
          expect(result.code, result.stderr).toBe(0);
          return JSON.parse(result.stdout);
        };
        const sessionRow = async () => {
          const result: SessionsListResult = await call("sessions.list", {
            agentId: "main",
            limit: 50,
          });
          return result.sessions.find((row) => row.key === sessionKey) ?? null;
        };
        const terminalNotification = (frame: Frame) => {
          const payload = frame.payload;
          if (!runId || frame.type !== "event" || payload?.sessionKey !== sessionKey) {
            return false;
          }
          if (payload.clientRunId === runId && payload.runId) {
            knownRunIds.add(payload.runId);
          }
          const explicitRunId = payload.clientRunId ?? payload.runId;
          const ownsRun = explicitRunId
            ? knownRunIds.has(explicitRunId)
            : payload.lastRunId === runId || payload.session?.lastRunId === runId;
          if (!ownsRun) {
            return false;
          }
          if (frame.event === "chat") {
            return ["final", "error", "aborted"].includes(payload.state ?? "");
          }
          if (frame.event === "agent") {
            return (
              payload.stream === "lifecycle" && ["end", "error"].includes(payload.data?.phase ?? "")
            );
          }
          if (frame.event === "sessions.changed" || frame.event === "session.message") {
            const terminalStatus = ["done", "failed", "timeout", "killed"].includes(
              payload.status ?? payload.session?.status ?? "",
            );
            return ["end", "error"].includes(payload.phase ?? "") || terminalStatus;
          }
          return false;
        };
        await call("sessions.create", {
          key: sessionKey,
          agentId: "main",
          label: "Stop finished run",
        });
        const handoff = await instance.cli(["dashboard", "--json"]);
        expect(handoff.code, handoff.stderr).toBe(0);
        const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
        const url = new URL(browserUrl);
        url.pathname = "/chat/main/stop-finished";
        url.search = "?nav=collapsed";
        try {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              await page.addInitScript(() => {
                localStorage.setItem(
                  "openclaw:control-ui:community-invite",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
              });
              page.on("pageerror", () => {
                proof.browserFailed = true;
              });
              await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
                sockets += 1;
                const server = socket.connectToServer();
                socket.onMessage((message) => {
                  const raw = message.toString();
                  const frame: Frame = JSON.parse(raw);
                  if (frame.type === "req") {
                    sent.push(frame);
                    if (frame.id) {
                      pending.set(frame.id, frame);
                    }
                    if (frame.method === "chat.send") {
                      const captured = frame.params?.idempotencyKey;
                      if (
                        runId ||
                        frame.params?.sessionKey !== sessionKey ||
                        typeof captured !== "string"
                      ) {
                        throw new Error(
                          "UNQUALIFIED: unexpected additional chat send or missing exact run identity",
                        );
                      }
                      runId = captured;
                      knownRunIds.add(captured);
                    }
                  }
                  server.send(message);
                });
                server.onMessage((message) => {
                  const raw = message.toString();
                  const frame: Frame = JSON.parse(raw);
                  if (frame.type === "res") {
                    received.push(frame);
                    if (frame.id) {
                      pending.delete(frame.id);
                    }
                  }
                  if (terminalNotification(frame)) {
                    dropped += 1;
                    // Preserve the sequence so reconnect cannot repair the deliberately missed terminal event.
                    const replacement = JSON.stringify({
                      ...frame,
                      event: "tick",
                      payload: { ts: Date.now() },
                    });
                    socket.send(replacement);
                  } else {
                    delivered.push(frame);
                    socket.send(message);
                  }
                });
              });
              const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
              const browserState = () =>
                pane.evaluate((element) => {
                  const state = (
                    element as HTMLElement & {
                      state: {
                        sessionKey: string;
                        chatRunId: string | null;
                        chatSending: boolean;
                        chatLoading: boolean;
                      };
                    }
                  ).state;
                  return {
                    sessionKey: state.sessionKey,
                    runId: state.chatRunId,
                    sending: state.chatSending,
                    loading: state.chatLoading,
                  };
                });
              try {
                stage = "open same-origin authenticated Chat";
                await page.goto(url.href);
                await waitForControlUiGatewayReady(page);
                const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
                await composer.fill("Finish this fixture turn.");
                await page.getByRole("button", { name: "Send message", exact: true }).click();
                const stop = page.getByRole("button", { name: "Stop generating", exact: true });
                await stop.waitFor({ state: "visible" });
                stage = "qualify active ownership before releasing provider";
                await expect.poll(browserState, { timeout: 15_000 }).toMatchObject({
                  sessionKey,
                  runId: expect.any(String),
                  sending: false,
                  loading: false,
                });
                expect((await browserState()).runId).toBe(runId);
                await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(1);
                const send = sent.find((frame) => frame.method === "chat.send");
                const sessionId = send?.params?.sessionId;
                if (!send || !runId || typeof sessionId !== "string") {
                  throw new Error(
                    "UNQUALIFIED: chat.send did not capture the exact session and run",
                  );
                }
                await expect
                  .poll(() => received.find((frame) => frame.id === send.id), { timeout: 15_000 })
                  .toMatchObject({ ok: true, payload: { runId, status: "started" } });
                await expect.poll(sessionRow, { timeout: 15_000 }).toMatchObject({
                  key: sessionKey,
                  sessionId,
                  hasActiveRun: true,
                  status: "running",
                });
                // Embedded ownership intentionally omits the complete activeRunIds set; scoped history retains the current run identity.
                const activeHistoryResponse = () =>
                  received.find((frame) => {
                    const request = sent.find((entry) => entry.id === frame.id);
                    return (
                      frame.ok === true &&
                      ["chat.startup", "chat.history"].includes(request?.method ?? "") &&
                      request?.params?.sessionKey === sessionKey &&
                      frame.payload?.sessionKey === sessionKey &&
                      frame.payload.sessionId === sessionId &&
                      frame.payload.sessionInfo?.key === sessionKey &&
                      frame.payload.sessionInfo.sessionId === sessionId &&
                      frame.payload.sessionInfo.hasActiveRun === true &&
                      frame.payload.sessionInfo.status === "running" &&
                      frame.payload.inFlightRun?.runId === runId
                    );
                  });
                await expect
                  .poll(activeHistoryResponse, {
                    timeout: 15_000,
                    message:
                      "UNQUALIFIED: no browser authoritative active-history observation for the exact run",
                  })
                  .toBeDefined();
                await expect
                  .poll(
                    () =>
                      [...pending.values()].filter((frame) =>
                        ["chat.send", "chat.startup", "chat.history", "sessions.list"].includes(
                          frame.method ?? "",
                        ),
                      ).length,
                    { timeout: 15_000 },
                  )
                  .toBe(0);
                const activeHistory = activeHistoryResponse();
                if (!activeHistory) {
                  throw new Error("UNQUALIFIED: exact active-history evidence is missing");
                }
                proof.activeHistoryMatchedRun = activeHistory.payload?.inFlightRun?.runId === runId;
                const activeRow = await sessionRow();
                proof.gatewayActive =
                  activeRow?.hasActiveRun === true && activeRow.status === "running";
                proof.browserOwnedActiveRun = (await browserState()).runId === runId;
                expect(sockets).toBe(1);
                provider.release();
                stage = "observe exact authoritative terminal row";
                await expect
                  .poll(sessionRow, { timeout: 30_000 })
                  .toMatchObject({ hasActiveRun: false, status: "done", lastRunId: runId });
                const terminalRow = await sessionRow();
                proof.gatewayFinishedExactRun =
                  terminalRow?.hasActiveRun === false &&
                  terminalRow.status === "done" &&
                  terminalRow.lastRunId === runId;
                expect(sockets, "UNQUALIFIED: browser reconnected before Stop").toBe(1);
                expect(sent.filter((frame) => frame.method === "connect")).toHaveLength(1);
                expect(
                  dropped,
                  "UNQUALIFIED: no exact terminal notification was withheld",
                ).toBeGreaterThan(0);
                expect(
                  provider.requests(),
                  "UNQUALIFIED: the provider handled more than one turn request",
                ).toBe(1);
                expect(
                  delivered.some(
                    (frame) =>
                      frame.type === "event" &&
                      frame.event === "chat" &&
                      frame.payload?.sessionKey === sessionKey &&
                      frame.payload.runId === runId &&
                      frame.payload.state === "delta",
                  ),
                  "UNQUALIFIED: no ordinary chat delta reached the browser",
                ).toBe(true);
                expect(
                  (await browserState()).runId,
                  "UNQUALIFIED: preserved traffic already reconciled the run before Stop",
                ).toBe(runId);
                expect(
                  await stop.isVisible(),
                  "UNQUALIFIED: Stop is not stale before the action",
                ).toBe(true);
                await page.screenshot({
                  path: path.join(artifactDir, "01-terminal-gateway-stale-stop.png"),
                });
                stage = "receive exact no-active-run Stop response";
                await stop.click();
                await expect
                  .poll(() => sent.find((frame) => frame.method === "chat.abort"), {
                    timeout: 10_000,
                  })
                  .toBeDefined();
                const abort = sent.find((frame) => frame.method === "chat.abort");
                if (!abort) {
                  throw new Error("UNQUALIFIED: Stop did not send chat.abort");
                }
                expect(abort.params).toMatchObject({ sessionKey, runId });
                await expect
                  .poll(() => received.find((frame) => frame.id === abort.id), { timeout: 10_000 })
                  .toMatchObject({ ok: true, payload: { ok: true, aborted: false, runIds: [] } });
                const abortResponse = received.find((frame) => frame.id === abort.id);
                proof.noActiveRunResponse =
                  abortResponse?.ok === true &&
                  abortResponse.payload?.aborted === false &&
                  abortResponse.payload.runIds?.length === 0;
                expect(sockets, "UNQUALIFIED: browser reconnected during Stop").toBe(1);
                stage = "recover completed ownership and restore Send";
                try {
                  await expect
                    .poll(async () => (await browserState()).runId, {
                      timeout: 10_000,
                      message:
                        "STALE_STOP: explicit no-active-run response did not reconcile completed local ownership",
                    })
                    .toBeNull();
                } finally {
                  const afterStop = await browserState();
                  proof.afterStopOwnsRun = afterStop.runId !== null;
                  proof.afterStopSending = afterStop.sending;
                  proof.afterStopLoading = afterStop.loading;
                  proof.afterStopStopVisible = await stop.isVisible();
                }
                await stop.waitFor({ state: "detached" });
                const abortIndex = sent.indexOf(abort);
                expect(
                  received.some((frame) => {
                    const request = sent.find((entry) => entry.id === frame.id);
                    return (
                      frame.ok === true &&
                      request !== undefined &&
                      sent.indexOf(request) > abortIndex &&
                      ["chat.startup", "chat.history"].includes(request.method ?? "") &&
                      request.params?.sessionKey === sessionKey &&
                      frame.payload?.sessionInfo?.key === sessionKey &&
                      frame.payload.sessionInfo.sessionId === sessionId &&
                      frame.payload.sessionInfo.hasActiveRun === false &&
                      frame.payload.sessionInfo.status === "done" &&
                      frame.payload.sessionInfo.lastRunId === runId
                    );
                  }),
                  "Recovered ownership requires a post-Stop authoritative history response",
                ).toBe(true);
                await page.locator(".chat-bubble").getByText(replyText, { exact: true }).waitFor();
                await composer.fill("Next draft");
                await page
                  .getByRole("button", { name: "Send message", exact: true })
                  .waitFor({ state: "visible" });
                await page.screenshot({ path: path.join(artifactDir, "03-send-restored.png") });
                expect(sockets).toBe(1);
                expect(sent.filter((frame) => frame.method === "connect")).toHaveLength(1);
                expect(sent.filter((frame) => frame.method === "chat.abort")).toHaveLength(1);
                proof.restoredRunCleared = (await browserState()).runId === null;
                proof.restoredSendVisible = await page
                  .getByRole("button", { name: "Send message", exact: true })
                  .isVisible();
                proof.restoredDraftPreserved = (await composer.inputValue()) === "Next draft";
                expect(await composer.inputValue()).toBe("Next draft");
              } finally {
                proof.stage = stage;
                proof.browserSockets = sockets;
                proof.connectRequests = sent.filter((frame) => frame.method === "connect").length;
                proof.droppedTerminalNotifications = dropped;
                proof.abortRequests = sent.filter((frame) => frame.method === "chat.abort").length;
                proof.pendingBrowserRequests = pending.size;
                proof.providerRequests = provider.requests();
              }
            },
          );
        } finally {
          await fs.writeFile(
            path.join(artifactDir, "proof.json"),
            JSON.stringify(proof, null, 2) + "\n",
          );
        }
      },
    });
  }, 240_000);
});
