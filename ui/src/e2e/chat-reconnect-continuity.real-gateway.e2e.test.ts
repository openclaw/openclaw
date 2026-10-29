import { expect, it, vi } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import { exactButton, requireString } from "./chat-flow.test-support.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:reconnect-continuity";
const firstPrompt = "Stream through a browser reconnect.";
const opening = "The first streamed section is visible. ";
const offlineTail = "The second section arrived while the browser was offline.";
const followUpPrompt = "Confirm the next turn is clean.";
const followUpReply = "The follow-up completed exactly once.";

type HistoryPayload = {
  inFlightRun?: { runId?: string; text?: string } | null;
  messages?: Array<{ role?: string }>;
};
type Frame = {
  connection: number;
  type?: string;
  id?: string;
  method?: string;
  ok?: boolean;
  params?: Record<string, unknown>;
  payload?: HistoryPayload & {
    initialHistory?: { ok?: boolean; payload?: HistoryPayload };
  };
};

let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;

const suite = createControlUiE2eSuite({
  name: "Control UI real Gateway reconnect continuity",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
    retainedState: () => instance.stateDir,
  },
  async startServer() {
    provider = await startScrollInferenceFixture();
    const close = () =>
      runQaGatewayFixture(
        async () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "control-ui-reconnect-continuity",
        provider: "reconnect",
        identity: "Reconnect fixture",
        model: "echo",
        apiKey: "synthetic-fixture-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: [{ id: "echo", name: "Reconnect fixture" }],
        agents: { ownership: "explicit" },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

const occurrences = (value: string, marker: string) => value.split(marker).length - 1;

suite.define(() => {
  it("reconstructs one streamed turn after browser socket loss, then aborts and follows up cleanly", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: "Reconnect",
      });
      const readHistory = () =>
        client.request<NonNullable<Frame["payload"]>>("chat.history", { sessionKey });
      const url = new URL("/chat/main/reconnect-continuity", suite.server.baseUrl);
      url.hash = new URLSearchParams({ token: instance.gatewayToken }).toString();

      await page.addInitScript(
        (key) => localStorage.setItem(key, '{"dismissedAtMs":1770000000000}'),
        "openclaw:control-ui:community-invite",
      );
      const sent: Frame[] = [];
      const received: Frame[] = [];
      const request = (method: string) => sent.find((frame) => frame.method === method);
      const response = (id: string | undefined, conn?: 1 | 2) =>
        received.find((frame) => frame.id === id && (!conn || frame.connection === conn));
      const ack = { type: "res", ok: true };
      const assistants = page.locator(".chat-group.assistant");
      const partial = assistants.filter({ hasText: opening.trim() });
      const assistant = (text: string) => assistants.getByText(text, { exact: true });
      const user = (text: string) => page.locator(".chat-group.user", { hasText: text });
      const expectPartial = async () => {
        expect(await partial.count()).toBe(1);
        const text = (await partial.textContent()) ?? "";
        expect(occurrences(text, opening.trim())).toBe(1);
        expect(occurrences(text, offlineTail)).toBe(1);
        const transcript = (await assistants.allTextContents()).join("\n");
        expect(occurrences(transcript, offlineTail)).toBe(1);
      };
      const reconnectGate = createDeferred();
      let connections = 0;
      let dropConnection: (() => void) | undefined;

      const websocketOrigin = new URL(suite.server.baseUrl);
      websocketOrigin.protocol = "ws:";
      await page.routeWebSocket(`${websocketOrigin.origin}/**`, async (socket) => {
        connections += 1;
        const connection = connections;
        if (connection > 1) {
          await reconnectGate.promise;
        }
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          sent.push({ ...(JSON.parse(message.toString()) as Frame), connection });
          server.send(message);
        });
        server.onMessage((message) => {
          received.push({ ...(JSON.parse(message.toString()) as Frame), connection });
          socket.send(message);
        });
        dropConnection = () => {
          void socket.close({ code: 1012, reason: "fixture browser link loss" });
        };
      });

      await page.goto(url.href);
      await waitForControlUiGatewayReady(page);
      const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
      const firstTurn = provider.plan();
      await composer.fill(firstPrompt);
      await exactButton(page, "Send message").click();
      await expect.poll(() => request("chat.send")?.id).toEqual(expect.any(String));
      const firstSend = request("chat.send");
      await expect.poll(() => response(firstSend?.id, 1)).toMatchObject(ack);
      await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(1);
      await firstTurn.append(opening);
      await assistant(opening.trim()).waitFor();

      const runId = requireString(firstSend?.params?.idempotencyKey, "first chat.send run ID");
      expect(connections).toBe(1);
      expect(dropConnection).toBeDefined();
      dropConnection?.();
      await waitForControlUiGatewayReconnecting(page);

      await firstTurn.append(offlineTail);
      await expect
        .poll(async () => (await readHistory()).inFlightRun, { timeout: 15_000 })
        .toMatchObject({ runId, text: opening + offlineTail });
      reconnectGate.resolve();
      await expect.poll(() => connections).toBe(2);
      await waitForControlUiGatewayReady(page);

      await expect.poll(async () => (await partial.textContent()) ?? "").toContain(offlineTail);
      await expectPartial();
      expect(await user(firstPrompt).count()).toBe(1);

      const historyRequest = sent.find(
        (frame) =>
          frame.connection === 2 &&
          frame.type === "req" &&
          ((["chat.startup", "chat.history"].includes(frame.method ?? "") &&
            frame.params?.sessionKey === sessionKey) ||
            (frame.method === "sessions.messages.subscribe" &&
              frame.params?.key === sessionKey &&
              frame.params.initialHistory !== undefined)),
      );
      expect(historyRequest?.id).toEqual(expect.any(String));
      const historyResponse = response(historyRequest?.id, 2);
      expect(historyResponse).toMatchObject({ type: "res", ok: true });
      const history =
        historyRequest?.method === "sessions.messages.subscribe"
          ? historyResponse?.payload?.initialHistory
          : { ok: historyResponse?.ok, payload: historyResponse?.payload };
      expect(history).toMatchObject({
        ok: true,
        payload: { inFlightRun: { runId, text: opening + offlineTail } },
      });

      const stop = exactButton(page, "Stop generating");
      await stop.waitFor({ state: "visible" });
      await stop.click();
      const aborts = () =>
        sent.filter(
          (frame) =>
            frame.method === "chat.abort" &&
            frame.params?.sessionKey === sessionKey &&
            frame.params?.runId === runId,
        );
      await expect.poll(() => aborts().length).toBe(1);
      await expect.poll(() => response(aborts()[0]?.id)).toMatchObject(ack);
      await stop.waitFor({ state: "detached" });

      // Stop acknowledges cancellation before the producer's deferred partial is persisted.
      await vi.waitFor(
        async () => {
          const abortedHistory = await readHistory();
          expect(abortedHistory.inFlightRun ?? null).toBeNull();
          const partials = abortedHistory.messages?.filter(({ role }) => role === "assistant");
          expect(partials).toHaveLength(1);
          expect(partials?.[0]).toMatchObject({
            content: [{ type: "text", text: opening + offlineTail }],
            idempotencyKey: `${runId}:assistant`,
            openclawAbort: { aborted: true, origin: "rpc", runId },
          });
        },
        { timeout: 15_000 },
      );

      const followUpTurn = provider.plan();
      await composer.fill(followUpPrompt);
      await exactButton(page, "Send message").click();
      await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(2);
      await stop.waitFor({ state: "visible" });
      await followUpTurn.append(followUpReply);
      await followUpTurn.finish();
      // Final text hands off from the live stream to persisted history at settlement.
      await stop.waitFor({ state: "detached" });
      await vi.waitFor(
        async () => {
          const completedHistory = await readHistory();
          expect(completedHistory.inFlightRun ?? null).toBeNull();
          expect(
            completedHistory.messages?.filter(({ role }) => role === "assistant"),
          ).toMatchObject([
            { content: [{ type: "text", text: opening + offlineTail }] },
            { content: [{ type: "text", text: followUpReply }] },
          ]);
        },
        { timeout: 15_000 },
      );
      await assistant(followUpReply).waitFor();

      await page.reload();
      await waitForControlUiGatewayReady(page);
      await assistant(followUpReply).waitFor();
      expect(await user(firstPrompt).count()).toBe(1);
      expect(await user(followUpPrompt).count()).toBe(1);
      await expectPartial();
      const groups = await page.locator(".chat-group").evaluateAll((elements) =>
        elements.map((group) => ({
          assistant: group.classList.contains("assistant"),
          user: group.classList.contains("user"),
          text: group.textContent ?? "",
        })),
      );
      expect(groups).toEqual([
        { assistant: false, user: true, text: expect.stringContaining(firstPrompt) },
        { assistant: true, user: false, text: expect.stringContaining(opening.trim()) },
        { assistant: false, user: true, text: expect.stringContaining(followUpPrompt) },
        { assistant: true, user: false, text: expect.stringContaining(followUpReply) },
      ]);
      expect(groups.at(-1)?.text).not.toContain(offlineTail);
      const transcript = groups.flatMap((row) => (row.assistant ? [row.text] : [])).join("\n");
      expect(occurrences(transcript, followUpReply)).toBe(1);
      expect([aborts().length, provider.requests()]).toEqual([1, 2]);
      expect(provider.failures).toEqual([]);
    });
  }, 120_000);
});
