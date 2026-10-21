import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import { exactButton, requireString } from "./chat-flow.test-support.ts";
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

type Frame = {
  connection: number;
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  payload?: {
    inFlightRun?: { runId?: string; text?: string } | null;
    messages?: Array<{ role?: string }>;
  };
};

let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;

const suite = createControlUiE2eSuite({
  name: "Control UI real Gateway reconnect continuity",
  startServerBeforeBrowser: true,
  resources: { run: async () => {}, retainedState: () => instance.stateDir },
  async startServer() {
    provider = await startScrollInferenceFixture();
    const close = () =>
      runQaGatewayFixture(
        async () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "control-ui-reconnect-continuity",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: { model: "reconnect/echo", modelPolicy: { allow: ["reconnect/*"] } },
            entries: { main: { identity: { name: "Reconnect fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              reconnect: {
                api: "openai-responses",
                apiKey: "synthetic-fixture-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                models: [{ id: "echo", name: "Reconnect fixture" }],
              },
            },
          },
          plugins: { allow: [] },
        },
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

async function call(method: string, params: Record<string, unknown>) {
  const args = ["gateway", "call", method, "--json", "--params", JSON.stringify(params)];
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

suite.define(() => {
  it("reconstructs one streamed turn after browser socket loss, then aborts and follows up cleanly", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await call("sessions.create", { key: sessionKey, agentId: "main", label: "Reconnect" });
      const readHistory = async () =>
        JSON.parse(await call("chat.history", { sessionKey })) as NonNullable<Frame["payload"]>;
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
          ["chat.startup", "chat.history"].includes(frame.method ?? "") &&
          frame.params?.sessionKey === sessionKey,
      );
      expect(historyRequest?.id).toEqual(expect.any(String));
      expect(response(historyRequest?.id, 2)).toMatchObject({
        type: "res",
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

      // A cursor-free CLI read proves persistence outside the browser cache and live stream buffer.
      const abortedHistory = await readHistory();
      expect(abortedHistory.inFlightRun ?? null).toBeNull();
      const partials = abortedHistory.messages?.filter(({ role }) => role === "assistant");
      expect(partials).toHaveLength(1);
      expect(partials?.[0]).toMatchObject({
        content: [{ type: "text", text: opening + offlineTail }],
        idempotencyKey: `${runId}:assistant`,
        openclawAbort: { aborted: true, origin: "rpc", runId },
      });

      const followUpTurn = provider.plan();
      await composer.fill(followUpPrompt);
      await exactButton(page, "Send message").click();
      await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(2);
      await followUpTurn.append(followUpReply);
      await followUpTurn.finish();
      await assistant(followUpReply).waitFor();
      await stop.waitFor({ state: "detached" });

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
      const index = (role: "user" | "assistant", text: string) =>
        groups.findIndex((group) => group[role] && group.text.includes(text));
      const firstUserIndex = index("user", firstPrompt);
      const firstAssistantIndex = index("assistant", opening.trim());
      const followUpUserIndex = index("user", followUpPrompt);
      const followUpAssistantIndex = index("assistant", followUpReply);
      expect(firstUserIndex).toBeGreaterThanOrEqual(0);
      expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
      expect(followUpUserIndex).toBeGreaterThan(firstAssistantIndex);
      expect(followUpAssistantIndex).toBeGreaterThan(followUpUserIndex);
      expect(groups[followUpAssistantIndex]?.text).not.toContain(offlineTail);
      const transcript = groups.flatMap((row) => (row.assistant ? [row.text] : [])).join("\n");
      expect(occurrences(transcript, followUpReply)).toBe(1);
      expect([aborts().length, provider.requests()]).toEqual([1, 2]);
      expect(provider.failures).toEqual([]);
    });
  }, 120_000);
});
