// Withhold this run's terminal notifications and delay terminal descriptors until Stop recovers from the Gateway's no-active-run answer.
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
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:stop-finished";
const replyText = "Finished reply from the fixture provider.";
type SessionDescriptor = {
  key?: string;
  lastRunId?: string | null;
  hasActiveRun?: boolean;
  status?: string;
};
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
  session?: SessionDescriptor;
  sessions?: SessionDescriptor[];
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
  error?: { code?: string };
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
  // Desired-behavior regression: keep editing available during recovery, then
  // admit ordinary input to the outbox before history, then deliver after it.
  // A fresh browser has no accepted history; hold real replies independently of
  // the real post-hello recovery digest, without replacing either result.
  it("allows editing during recovery and queues before initial history completes", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const diagnosticSession = "agent:main:send-boundary";
        const created = await instance.cli([
          "gateway",
          "call",
          "sessions.create",
          "--json",
          "--params",
          JSON.stringify({ key: diagnosticSession, agentId: "main", label: "Send boundary" }),
        ]);
        expect(created.code, created.stderr).toBe(0);
        const handoff = await instance.cli(["dashboard", "--json"]);
        expect(handoff.code, handoff.stderr).toBe(0);
        const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
        const url = new URL(browserUrl);
        url.pathname = "/chat/main/send-boundary";
        url.search = "";
        let stage = "install independent recovery and history holds";
        let sendRequests = 0;
        let sendRequest: Frame | undefined;
        let sendResponse: Frame | undefined;
        let proxyForwardingReturned = false;
        let authoritativeHistory:
          | { sessionId?: string; activeLeafEntryId?: string | null }
          | undefined;
        let connectRequests = 0;
        let historyResponses = 0;
        let successfulHistoryResponses = 0;
        let deliveredHistoryResponses = 0;
        let holdHistory = true;
        const heldHistory: Array<() => void> = [];
        const pending = new Map<string, { method?: string; sessionKey?: unknown }>();
        try {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              await page.addInitScript(() => {
                localStorage.setItem(
                  "openclaw:control-ui:community-invite",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
                const nativeDigest = crypto.subtle.digest;
                const NativeWebSocket = window.WebSocket;
                let armed = false;
                let releaseDigest!: () => void;
                const released = new Promise<void>((resolve) => {
                  releaseDigest = resolve;
                });
                // Only the first digest synchronously initiated by the delivered
                // connect response is delayed. Device identity/signing precedes
                // hello; all digest bytes/results and authentication stay real.
                crypto.subtle.digest = function (...args) {
                  const result = nativeDigest.apply(this, args);
                  if (!armed) return result;
                  armed = false;
                  document.documentElement.dataset.diagnosticHeldDigests = String(
                    Number(document.documentElement.dataset.diagnosticHeldDigests ?? 0) + 1,
                  );
                  return result.then(async (digest) => {
                    await released;
                    return digest;
                  });
                };
                window.WebSocket = class extends NativeWebSocket {
                  private connectId: string | undefined;
                  constructor(url: string | URL, protocols?: string | string[]) {
                    super(url, protocols);
                    this.addEventListener("message", (event: MessageEvent) => {
                      if (typeof event.data !== "string") return;
                      const frame = JSON.parse(event.data) as {
                        type?: string;
                        id?: string;
                        ok?: boolean;
                      };
                      if (
                        frame.type === "res" &&
                        frame.id === this.connectId &&
                        frame.ok === true
                      ) {
                        // Installed before the application's message listener.
                        armed = true;
                      }
                    });
                  }
                  override send(...args: Parameters<WebSocket["send"]>) {
                    const [data] = args;
                    if (typeof data === "string") {
                      const frame = JSON.parse(data) as {
                        type?: string;
                        method?: string;
                        id?: string;
                      };
                      if (frame.type === "req" && frame.method === "connect")
                        this.connectId = frame.id;
                    }
                    super.send(...args);
                  }
                };
                (window as Window & { releaseSendDiagnostic?: () => void }).releaseSendDiagnostic =
                  () => {
                    armed = false;
                    releaseDigest();
                    crypto.subtle.digest = nativeDigest;
                    window.WebSocket = NativeWebSocket;
                  };
              });
              page.on("pageerror", () => {
                proof.browserFailed = true;
              });

              await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
                const server = socket.connectToServer();
                socket.onMessage((message) => {
                  const frame: Frame = JSON.parse(message.toString());
                  if (frame.type === "req" && frame.id) {
                    pending.set(frame.id, {
                      method: frame.method,
                      sessionKey: frame.params?.sessionKey,
                    });
                    if (frame.method === "connect") connectRequests += 1;
                    if (frame.method === "chat.send") {
                      sendRequests += 1;
                      sendRequest = frame;
                    }
                  }
                  server.send(message);
                  if (frame.type === "req" && frame.method === "chat.send") {
                    proxyForwardingReturned = true;
                  }
                });
                server.onMessage((message) => {
                  const frame: Frame = JSON.parse(message.toString());
                  const request = frame.id ? pending.get(frame.id) : undefined;
                  if (frame.type === "res" && request?.method === "chat.send") {
                    sendResponse = frame;
                  }
                  const history =
                    frame.type === "res" &&
                    ["chat.startup", "chat.history"].includes(request?.method ?? "") &&
                    request?.sessionKey === diagnosticSession;
                  const deliver = () => {
                    if (frame.type === "res" && frame.id) pending.delete(frame.id);
                    if (history) deliveredHistoryResponses += 1;
                    socket.send(message);
                  };
                  if (history) {
                    historyResponses += 1;
                    if (frame.ok === true && frame.payload?.sessionKey === diagnosticSession) {
                      successfulHistoryResponses += 1;
                      const payload = frame.payload as EventPayload & {
                        sessionInfo?: { activeLeafEntryId?: string | null };
                      };
                      authoritativeHistory = {
                        sessionId: payload.sessionId,
                        activeLeafEntryId: payload.sessionInfo?.activeLeafEntryId,
                      };
                    }
                  }
                  if (history && holdHistory) heldHistory.push(deliver);
                  else deliver();
                });
              });
              const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
              const browserState = () =>
                pane.evaluate((element) => {
                  const host = element as HTMLElement & {
                    state: ChatPageHost;
                    context: { gateway: { snapshot: { phase: string } } };
                  };
                  const state = host.state;
                  // Read the existing serialized outbox contract, not just its live projection.
                  // The exact synthetic scope keeps other conversations out of this proof.
                  const stored = JSON.parse(
                    sessionStorage.getItem(
                      `openclaw.control.chatComposer.v4:${encodeURIComponent(state.settings.gatewayUrl?.trim() || "default")}`,
                    ) ?? '{"sessions":{}}',
                  ) as {
                    sessions: Record<
                      string,
                      {
                        queue?: Array<{
                          id: string;
                          text: string;
                          sendRunId?: string;
                          sendAttempts?: number;
                          queueMode?: string;
                        }>;
                      }
                    >;
                  };
                  const persisted =
                    stored.sessions["agent:main:send-boundary\u0000agent:main"]?.queue ?? [];
                  return {
                    phase: host.context.gateway.snapshot.phase,
                    sessionMatches: state.sessionKey === "agent:main:send-boundary",
                    connected: state.connected,
                    recoveryReady: state.client?.recoveryScopeReady === true,
                    recoveryPending: state.client?.recoveryScopeReady === false,
                    historyLoading: state.chatLoading,
                    draftLength: state.chatMessage.length,
                    runId: state.chatRunId,
                    sending: state.chatSending,
                    hasError: Boolean(state.chatError || state.lastError || state.chatRunError),
                    // chatQueue is the real outbox owner's current-scope projection,
                    // not a test-owned array or a count inferred from the DOM.
                    outboxCount: state.chatQueue.length,
                    queuedOriginalDraft: state.chatQueue[0]?.text === "Finish this fixture turn.",
                    queuedSendAttempts: state.chatQueue[0]?.sendAttempts ?? 0,
                    persistedCount: persisted.length,
                    persistedOriginalDraft: persisted[0]?.text === "Finish this fixture turn.",
                    persistedMatchesProjection: persisted[0]?.id === state.chatQueue[0]?.id,
                    persistedRunId: persisted[0]?.sendRunId,
                    persistedSendAttempts: persisted[0]?.sendAttempts ?? 0,
                    persistedQueueMode: persisted[0]?.queueMode,
                    handlerEntries: Number(
                      element.getAttribute("data-diagnostic-handler-entries") ?? 0,
                    ),
                    handlerSettled: Number(
                      element.getAttribute("data-diagnostic-handler-settled") ?? 0,
                    ),
                    heldDigests: Number(
                      document.documentElement.dataset.diagnosticHeldDigests ?? 0,
                    ),
                    activeSubmitGuards: state.chatSubmitGuards?.size ?? 0,
                  };
                });
              let restoreHandler = false;
              const releaseRecovery = async () => {
                await page.evaluate(() => {
                  (
                    window as Window & { releaseSendDiagnostic?: () => void }
                  ).releaseSendDiagnostic?.();
                });
              };
              const releaseHistory = () => {
                holdHistory = false;
                for (const deliver of heldHistory.splice(0)) deliver();
              };
              try {
                stage = "qualify connected with recovery and initial history held";
                await page.goto(url.href);
                await waitForControlUiGatewayReady(page);
                await expect.poll(() => successfulHistoryResponses).toBeGreaterThan(0);
                await expect.poll(browserState).toMatchObject({
                  phase: "connected",
                  sessionMatches: true,
                  connected: true,
                  recoveryReady: false,
                  recoveryPending: true,
                  historyLoading: true,
                  heldDigests: 1,
                  outboxCount: 0,
                });
                expect(deliveredHistoryResponses).toBe(0);
                expect(connectRequests).toBe(1);
                const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
                const draft = "Finish this fixture turn.";
                await composer.fill(draft);
                // The disabled control names its hold reason, not "Send message".
                const send = pane.locator("button.chat-send-btn--send");
                await pane.evaluate((element) => {
                  const host = element as HTMLElement & {
                    state: ChatPageHost;
                    restoreDiagnosticHandler?: () => void;
                  };
                  const original = host.state.handleSendChat;
                  host.state.handleSendChat = function (...args) {
                    element.setAttribute(
                      "data-diagnostic-handler-entries",
                      String(
                        Number(element.getAttribute("data-diagnostic-handler-entries") ?? 0) + 1,
                      ),
                    );
                    const result = original.apply(this, args);
                    // Observe settlement without replacing the returned promise.
                    void result.then(
                      () => {
                        element.setAttribute(
                          "data-diagnostic-handler-settled",
                          String(
                            Number(element.getAttribute("data-diagnostic-handler-settled") ?? 0) +
                              1,
                          ),
                        );
                      },
                      () => {
                        element.setAttribute("data-diagnostic-handler-failed", "true");
                      },
                    );
                    return result;
                  };
                  host.restoreDiagnosticHandler = () => {
                    host.state.handleSendChat = original;
                  };
                });
                restoreHandler = true;
                stage = "keep draft editing available but disable Send during recovery";
                await expect.poll(() => composer.isEditable()).toBe(true);
                expect(await composer.inputValue()).toBe(draft);
                await pane.evaluate(async (element) => {
                  await (element as HTMLElement & { updateComplete: Promise<boolean> })
                    .updateComplete;
                });
                const beforeRecovery = await browserState();
                // Record the actual control state before the assertion so a red
                // run retains evidence instead of a hard-coded desired value.
                const sendEnabledWhileRecovering = await send.isEnabled();
                Object.assign(proof, {
                  connectedWhileRecovering: beforeRecovery.connected,
                  recoveryReadyBeforeRelease: beforeRecovery.recoveryReady,
                  initialHistoryUnavailableBeforeRelease:
                    beforeRecovery.historyLoading && deliveredHistoryResponses === 0,
                  sendEnabledWhileRecovering,
                  draftLengthBeforeRelease: beforeRecovery.draftLength,
                  handlerEntriesBeforeRelease: beforeRecovery.handlerEntries,
                  outboxCountBeforeRelease: beforeRecovery.outboxCount,
                  sendRequestsBeforeRelease: sendRequests,
                  heldRecoveryDigests: beforeRecovery.heldDigests,
                });
                // Crop to the synthetic composer and Send control; never capture
                // browser chrome, connection details, or the invitation surface.
                await pane.locator(".agent-chat__input--chat").screenshot({
                  path: path.join(artifactDir, "recovery-send.png"),
                  animations: "disabled",
                });
                expect(sendEnabledWhileRecovering).toBe(false);
                expect(beforeRecovery).toMatchObject({
                  recoveryReady: false,
                  historyLoading: true,
                  draftLength: draft.length,
                  handlerEntries: 0,
                  outboxCount: 0,
                });
                expect(sendRequests).toBe(0);
                expect(deliveredHistoryResponses).toBe(0);

                stage = "release only recovery with genuine initial history still withheld";
                await releaseRecovery();
                await expect.poll(browserState).toMatchObject({
                  phase: "connected",
                  recoveryReady: true,
                  historyLoading: true,
                  draftLength: draft.length,
                  handlerEntries: 0,
                  outboxCount: 0,
                });
                await expect.poll(() => send.isEnabled()).toBe(true);
                expect(await composer.inputValue()).toBe(draft);
                expect(deliveredHistoryResponses).toBe(0);
                expect(sendRequests).toBe(0);
                proof.sendEnabledAfterRecovery = await send.isEnabled();
                proof.historyPendingAfterRecovery = (await browserState()).historyLoading;

                stage = "admit the original draft to the outbox while history remains pending";
                await send.click();
                await expect.poll(browserState).toMatchObject({
                  recoveryReady: true,
                  historyLoading: true,
                  handlerEntries: 1,
                  handlerSettled: 0,
                  draftLength: 0,
                  outboxCount: 1,
                  queuedOriginalDraft: true,
                  queuedSendAttempts: 0,
                  persistedCount: 1,
                  persistedOriginalDraft: true,
                  persistedMatchesProjection: true,
                  persistedSendAttempts: 0,
                  persistedQueueMode: "steer",
                  runId: null,
                  hasError: false,
                });
                const queuedRunId = (await browserState()).persistedRunId;
                expect(queuedRunId).toEqual(expect.any(String));
                expect(sendRequests).toBe(0);
                expect(proxyForwardingReturned).toBe(false);
                expect(sendResponse).toBeUndefined();
                expect(provider.requests()).toBe(0);
                expect(deliveredHistoryResponses).toBe(0);
                const nextDraft = "Keep my next draft.";
                await composer.fill(nextDraft);
                expect(await composer.inputValue()).toBe(nextDraft);
                Object.assign(proof, {
                  originalDraftQueuedBeforeHistory: true,
                  durableOriginalDraftBeforeHistory: true,
                  durableSendAttemptsBeforeHistory: 0,
                  durableSteerPolicyBeforeHistory: true,
                  sendRequestsBeforeHistoryRelease: sendRequests,
                  providerRequestsBeforeHistoryRelease: provider.requests(),
                  deliveredHistoryResponsesBeforeRelease: deliveredHistoryResponses,
                  nextDraftEditableWhileQueued: true,
                });

                // The documented contract joins authoritative session/branch history
                // before delivery; this is not a Gateway ACK-before-history guarantee.
                stage = "release authoritative history and deliver the queued draft once";
                const initialHistory = { ...authoritativeHistory };
                expect(initialHistory.sessionId).toEqual(expect.any(String));
                expect(initialHistory.activeLeafEntryId).toBeNull();
                releaseHistory();
                await expect
                  .poll(() => sendResponse)
                  .toMatchObject({
                    ok: true,
                    payload: { runId: expect.any(String), status: "started" },
                  });
                expect(sendRequests).toBe(1);
                expect(sendRequest?.params).toMatchObject({
                  sessionKey: diagnosticSession,
                  message: draft,
                  idempotencyKey: queuedRunId,
                  sessionId: initialHistory.sessionId,
                  queueMode: "steer",
                });
                // Start-or-steer follows the Gateway-owned branch, including when idle.
                // Later history may advance its leaf after this accepted send.
                expect(sendRequest?.params).not.toHaveProperty("expectedLeafEntryId");
                const runId = queuedRunId;
                expect(sendResponse?.payload?.runId).toBe(runId);
                await expect.poll(() => provider.requests()).toBe(1);
                const stop = page.getByRole("button", { name: "Stop generating", exact: true });
                await stop.waitFor({ state: "visible" });
                await expect.poll(browserState).toMatchObject({
                  recoveryReady: true,
                  historyLoading: false,
                  runId,
                  sending: false,
                  handlerEntries: 1,
                  handlerSettled: 1,
                  activeSubmitGuards: 0,
                  draftLength: nextDraft.length,
                  hasError: false,
                });
                expect(deliveredHistoryResponses).toBeGreaterThan(0);
                expect(await composer.inputValue()).toBe(nextDraft);
                Object.assign(proof, {
                  originalDraftSent: sendRequest?.params?.message === draft,
                  sendAccepted:
                    sendResponse?.ok === true && sendResponse.payload?.status === "started",
                  acceptedRunMatchesRequest: sendResponse?.payload?.runId === runId,
                  deliveredToAuthoritativeSessionWithSteerPolicy: true,
                  providerRequestsAfterHistory: provider.requests(),
                  stopVisibleAfterHistory: await stop.isVisible(),
                  historyPendingAfterSend: (await browserState()).historyLoading,
                  deliveredHistoryResponsesAtSend: deliveredHistoryResponses,
                });

                stage =
                  "release provider and settle the accepted run without replacing the next draft";
                provider.release();
                await page.locator(".chat-bubble").getByText(replyText, { exact: true }).waitFor();
                await expect.poll(browserState).toMatchObject({
                  recoveryReady: true,
                  historyLoading: false,
                  runId: null,
                  sending: false,
                  handlerEntries: 1,
                  handlerSettled: 1,
                  activeSubmitGuards: 0,
                  draftLength: nextDraft.length,
                  outboxCount: 0,
                  persistedCount: 0,
                  hasError: false,
                });
                expect(await composer.inputValue()).toBe(nextDraft);
                await stop.waitFor({ state: "detached" });
                await expect
                  .poll(async () => {
                    const result = await instance.cli([
                      "gateway",
                      "call",
                      "sessions.list",
                      "--json",
                      "--params",
                      JSON.stringify({ agentId: "main", limit: 50 }),
                    ]);
                    expect(result.code, result.stderr).toBe(0);
                    const rows: SessionsListResult = JSON.parse(result.stdout);
                    return rows.sessions.find((row) => row.key === diagnosticSession);
                  })
                  .toMatchObject({ hasActiveRun: false, status: "done", lastRunId: runId });
                expect(connectRequests).toBe(1);
                expect(sendRequests).toBe(1);
                expect(provider.requests()).toBe(1);
                expect(deliveredHistoryResponses).toBeGreaterThan(0);
                expect(proof.browserFailed).not.toBe(true);
                proof.visibleReplyAndRunSettled = true;
                stage =
                  "draft admitted before history; delivered once after history; next draft preserved";
              } finally {
                // Observe transport before cleanup releases any remaining history.
                proof.proxyForwardingReturned = proxyForwardingReturned;
                proof.sendResponseReceived = sendResponse !== undefined;
                proof.sendRequestsBeforeCleanup = sendRequests;
                try {
                  const finalState = await browserState();
                  Object.assign(proof, {
                    handlerEntries: finalState.handlerEntries,
                    handlerSettled: finalState.handlerSettled,
                    finalDraftLength: finalState.draftLength,
                    finalOutboxCount: finalState.outboxCount,
                    finalOwnsRun: finalState.runId !== null,
                    finalHistoryLoading: finalState.historyLoading,
                    finalRecoveryReady: finalState.recoveryReady,
                    finalHasError: finalState.hasError,
                  });
                } catch {
                  proof.finalBrowserStateUnavailable = true;
                }
                try {
                  await releaseRecovery();
                } finally {
                  releaseHistory();
                  provider.release();
                }
                if (restoreHandler)
                  await pane.evaluate((element) => {
                    (
                      element as HTMLElement & { restoreDiagnosticHandler?: () => void }
                    ).restoreDiagnosticHandler?.();
                  });
                proof.heldHistoryResponses = historyResponses;
                proof.successfulHistoryResponses = successfulHistoryResponses;
                proof.deliveredHistoryResponses = deliveredHistoryResponses;
                proof.pendingHeldHistoryResponses = heldHistory.length;
                proof.connectRequests = connectRequests;
                proof.sendRequests = sendRequests;
                proof.providerRequests = provider.requests();
              }
            },
          );
        } finally {
          proof.stage = stage;
          await fs.writeFile(
            path.join(artifactDir, "proof.json"),
            JSON.stringify(proof, null, 2) + "\n",
          );
        }
      },
    });
  }, 120_000);

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
        let delayTerminalDescriptors = true;
        let delayedTerminalDescriptors = 0;
        const deferredDescriptors: Array<() => void> = [];
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
        url.search = "";
        try {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              await page.addInitScript(() => {
                localStorage.setItem(
                  "openclaw:control-ui:community-invite",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
                for (const kind of ["pointerdown", "click"]) {
                  document.addEventListener(
                    kind,
                    (event) => {
                      if (
                        event
                          .composedPath()
                          .some(
                            (target) =>
                              target instanceof HTMLButtonElement &&
                              target.classList.contains("chat-send-btn--send"),
                          )
                      ) {
                        const key =
                          kind === "click" ? "diagnosticSendClicks" : "diagnosticSendPointers";
                        document.documentElement.dataset[key] = String(
                          Number(document.documentElement.dataset[key] ?? 0) + 1,
                        );
                      }
                    },
                    true,
                  );
                }
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
                  const request = frame.id ? pending.get(frame.id) : undefined;
                  if (frame.type === "res") {
                    received.push(frame);
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
                    const deliver = () => {
                      if (frame.type === "res" && frame.id) {
                        pending.delete(frame.id);
                      }
                      delivered.push(frame);
                      socket.send(message);
                    };
                    const session = frame.payload?.session;
                    const hasTerminalDescriptor =
                      (request?.method === "sessions.describe" &&
                        request.params?.key === sessionKey &&
                        session?.lastRunId === runId &&
                        session?.status === "done") ||
                      (request?.method === "sessions.list" &&
                        frame.payload?.sessions?.some(
                          (row) =>
                            row.key === sessionKey &&
                            row.lastRunId === runId &&
                            row.status === "done",
                        ));
                    if (
                      delayTerminalDescriptors &&
                      runId &&
                      frame.type === "res" &&
                      frame.ok === true &&
                      hasTerminalDescriptor
                    ) {
                      // Shared descriptor observations can settle ownership before Stop.
                      // Delay this exact terminal fact, then deliver the real reply unchanged.
                      delayedTerminalDescriptors += 1;
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
                        chatMessage: string;
                        chatError?: string | null;
                        lastError?: string | null;
                        currentSessionId?: string | null;
                      };
                    }
                  ).state;
                  return {
                    sessionKey: state.sessionKey,
                    runId: state.chatRunId,
                    sending: state.chatSending,
                    loading: state.chatLoading,
                    draftLength: state.chatMessage.length,
                    hasChatError: Boolean(state.chatError),
                    hasLastError: Boolean(state.lastError),
                    hasSessionId: Boolean(state.currentSessionId),
                    sendClicks: Number(document.documentElement.dataset.diagnosticSendClicks ?? 0),
                    sendPointers: Number(
                      document.documentElement.dataset.diagnosticSendPointers ?? 0,
                    ),
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
                delayTerminalDescriptors = false;
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
                proof.delayedTerminalDescriptors = delayedTerminalDescriptors;
                proof.pendingTerminalDescriptors = deferredDescriptors.length;
                proof.abortRequests = sent.filter((frame) => frame.method === "chat.abort").length;
                proof.pendingBrowserRequests = pending.size;
                proof.providerRequests = provider.requests();
                const sends = sent.filter((frame) => frame.method === "chat.send");
                proof.sendRequests = sends.length;
                proof.sendResponses = JSON.stringify(
                  sends.map((request) => {
                    const response = received.find((frame) => frame.id === request.id);
                    return {
                      received: Boolean(response),
                      ok: response?.ok,
                      status: response?.payload?.status,
                      errorCode: response?.error?.code,
                    };
                  }),
                );
                proof.pendingChatRequests = [...pending.values()].filter((frame) =>
                  ["chat.send", "chat.startup", "chat.history", "sessions.list"].includes(
                    frame.method ?? "",
                  ),
                ).length;
                try {
                  proof.finalBrowserState = JSON.stringify(await browserState());
                } catch {
                  proof.finalBrowserStateUnavailable = true;
                }
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
