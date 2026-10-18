// Withhold this run's terminal observations until Stop recovers from the Gateway's no-active-run answer.
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
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:stop-finished";
const replyText = "Finished reply from the fixture provider.";
type SessionDescriptor = {
  key?: string;
  sessionId?: string;
  lastRunId?: string | null;
  hasActiveRun?: boolean;
  status?: string;
};
type EventPayload = {
  kind?: string;
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
  session?: SessionDescriptor;
  sessions?: SessionDescriptor[];
  ok?: boolean;
  aborted?: boolean;
  runIds?: string[];
  sessionInfo?: SessionDescriptor;
};
type Frame = {
  type: string;
  id?: string;
  ok?: boolean;
  error?: { code?: string; message?: string };
  method?: string;
  params?: Record<string, unknown>;
  event?: string;
  seq?: number;
  payload?: EventPayload;
};
let artifactDir: string;
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
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
          } finally {
            await provider.stop();
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
        let capturedSessionId: string | undefined;
        let withholdCompletionNotifications = false;
        let sockets = 0;
        let dropped = 0;
        let delayTerminalDescriptors = true;
        const deferredDescriptors: Array<() => void> = [];
        const call = async (method: string, params: Record<string, unknown>) => {
          const args = ["gateway", "call", method, "--json", "--params", JSON.stringify(params)];
          const result = await instance.cli(args);
          expect(result.code, `${method}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(
            0,
          );
          return JSON.parse(result.stdout);
        };
        const sessionRow = async () => {
          const result: SessionsListResult = await call("sessions.list", {
            agentId: "main",
            limit: 50,
          });
          return result.sessions.find((row) => row.key === sessionKey) ?? null;
        };
        const shouldWithholdNotification = (frame: Frame) => {
          const payload = frame.payload;
          if (
            !runId ||
            frame.type !== "event" ||
            !payload ||
            (payload.sessionKey ?? payload.session?.key) !== sessionKey
          ) {
            return false;
          }
          if (
            withholdCompletionNotifications &&
            capturedSessionId &&
            (payload.sessionId === undefined || payload.sessionId === capturedSessionId) &&
            (frame.event === "sessions.changed" || frame.event === "session.message")
          ) {
            // Cleanup can trigger history before its terminal snapshot is published.
            return true;
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
        url.search = "";
        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
          async ({ page }) => {
            await page.addInitScript(() => {
              localStorage.setItem(
                "openclaw:control-ui:community-invite:v2",
                JSON.stringify({ dismissedAtMs: 1770000000000 }),
              );
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
                    const requestedSessionId = frame.params?.sessionId;
                    if (
                      runId ||
                      frame.params?.sessionKey !== sessionKey ||
                      typeof captured !== "string" ||
                      typeof requestedSessionId !== "string"
                    ) {
                      throw new Error(
                        "UNQUALIFIED: unexpected additional chat send or missing exact run identity",
                      );
                    }
                    runId = captured;
                    capturedSessionId = requestedSessionId;
                    knownRunIds.add(captured);
                  }
                }
                server.send(message);
              });
              server.onMessage((message) => {
                const raw = message.toString();
                const frame: Frame = JSON.parse(raw);
                const request = frame.id ? pending.get(frame.id) : undefined;
                if (frame.type === "res") {
                  received.push(frame);
                }
                if (shouldWithholdNotification(frame)) {
                  dropped += 1;
                  // Preserve the sequence so reconnect cannot repair the deliberately missed terminal event.
                  const replacement = JSON.stringify({
                    ...frame,
                    event: "tick",
                    payload: { ts: Date.now() },
                  });
                  socket.send(replacement);
                } else {
                  const deliver = () => {
                    if (frame.type === "res" && frame.id) {
                      pending.delete(frame.id);
                    }
                    delivered.push(frame);
                    socket.send(message);
                  };
                  const session = frame.payload?.session;
                  const historySession = frame.payload?.sessionInfo;
                  const abortIndex = sent.findIndex((entry) => entry.method === "chat.abort");
                  const hasPreStopTerminalHistory =
                    withholdCompletionNotifications &&
                    request !== undefined &&
                    ["chat.startup", "chat.history"].includes(request.method ?? "") &&
                    request.params?.sessionKey === sessionKey &&
                    historySession?.key === sessionKey &&
                    historySession.hasActiveRun === false &&
                    (abortIndex < 0 || sent.indexOf(request) < abortIndex);
                  const hasTerminalDescriptor =
                    withholdCompletionNotifications &&
                    ((request?.method === "sessions.describe" &&
                      request.params?.key === sessionKey &&
                      session?.hasActiveRun === false) ||
                      (request?.method === "sessions.list" &&
                        frame.payload?.sessions?.some(
                          (row) => row.key === sessionKey && row.hasActiveRun === false,
                        )));
                  if (
                    delayTerminalDescriptors &&
                    runId &&
                    frame.type === "res" &&
                    frame.ok === true &&
                    (hasTerminalDescriptor || hasPreStopTerminalHistory)
                  ) {
                    // Even compact idle rows retire ownership without status or lastRunId.
                    // Only history requested after Stop can prove recovery.
                    deferredDescriptors.push(deliver);
                  } else {
                    deliver();
                  }
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
            await page.goto(url.href);
            await enterControlUiSession(page);
            await waitForControlUiGatewayReady(page);
            const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
            await composer.fill("Finish this fixture turn.");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const stop = page.getByRole("button", { name: "Stop generating", exact: true });
            await stop.waitFor({ state: "visible" });
            const send = sent.find((frame) => frame.method === "chat.send");
            const sessionId = send?.params?.sessionId;
            if (!send || !runId || typeof sessionId !== "string") {
              throw new Error("UNQUALIFIED: chat.send did not capture the exact session and run");
            }
            await expect
              .poll(() => received.find((frame) => frame.id === send.id), { timeout: 15_000 })
              .toMatchObject({ ok: true, payload: { runId, status: "started" } });
            await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(1);
            await expect.poll(browserState, { timeout: 15_000 }).toMatchObject({
              sessionKey,
              runId,
              sending: false,
              loading: false,
            });
            await expect.poll(sessionRow, { timeout: 15_000 }).toMatchObject({
              key: sessionKey,
              sessionId,
              hasActiveRun: true,
              status: "running",
            });
            // Cursor deltas carry session identity in sessionInfo instead of the full snapshot envelope.
            const activeHistoryResponse = () =>
              received.find((frame) => {
                const request = sent.find((entry) => entry.id === frame.id);
                return (
                  frame.ok === true &&
                  ["chat.startup", "chat.history"].includes(request?.method ?? "") &&
                  request?.params?.sessionKey === sessionKey &&
                  (frame.payload?.kind === "delta" ||
                    (frame.payload?.sessionKey === sessionKey &&
                      frame.payload.sessionId === sessionId)) &&
                  frame.payload?.sessionInfo?.key === sessionKey &&
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
            expect(sockets).toBe(1);
            withholdCompletionNotifications = true;
            provider.release();
            await expect
              .poll(sessionRow, { timeout: 30_000 })
              .toMatchObject({ hasActiveRun: false, status: "done", lastRunId: runId });
            expect(
              dropped,
              "UNQUALIFIED: no exact terminal notification was withheld",
            ).toBeGreaterThan(0);
            expect(
              {
                sockets,
                connects: sent.filter((frame) => frame.method === "connect").length,
                providerRequests: provider.requests(),
                deliveredDelta: delivered.some(
                  (frame) =>
                    frame.type === "event" &&
                    frame.event === "chat" &&
                    frame.payload?.sessionKey === sessionKey &&
                    frame.payload.runId === runId &&
                    frame.payload.state === "delta",
                ),
                ownedRun: (await browserState()).runId,
                staleStopVisible: await stop.isVisible(),
              },
              "UNQUALIFIED: terminal Gateway run must still be owned by the connected browser",
            ).toEqual({
              sockets: 1,
              connects: 1,
              providerRequests: 1,
              deliveredDelta: true,
              ownedRun: runId,
              staleStopVisible: true,
            });
            await page.screenshot({
              path: path.join(artifactDir, "01-terminal-gateway-stale-stop.png"),
            });
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
            expect(sockets, "UNQUALIFIED: browser reconnected during Stop").toBe(1);
            await expect
              .poll(async () => (await browserState()).runId, {
                timeout: 10_000,
                message:
                  "STALE_STOP: explicit no-active-run response did not reconcile completed local ownership",
              })
              .toBeNull();
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
            delayTerminalDescriptors = false;
            withholdCompletionNotifications = false;
            for (const deliver of deferredDescriptors.splice(0)) {
              deliver();
            }
            await page.locator(".chat-bubble").getByText(replyText, { exact: true }).waitFor();
            await composer.fill("Next draft");
            await page
              .getByRole("button", { name: "Send message", exact: true })
              .waitFor({ state: "visible" });
            await page.screenshot({ path: path.join(artifactDir, "03-send-restored.png") });
            expect(sockets).toBe(1);
            expect(sent.filter((frame) => frame.method === "connect")).toHaveLength(1);
            expect(sent.filter((frame) => frame.method === "chat.abort")).toHaveLength(1);
            expect(await composer.inputValue()).toBe("Next draft");
          },
        );
      },
    });
  }, 240_000);
});
