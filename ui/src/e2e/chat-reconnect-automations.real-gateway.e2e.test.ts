// Inference is scripted; one malformed leaf is injected to trigger a real admission
// rejection. Browser recovery, authentication, tools and inventory use the Gateway.
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { evaluateSessionFreshness } from "../../../src/config/sessions/reset-policy.ts";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../src/config/sessions/session-accessor.ts";
import { writeToolCall } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import {
  callGateway,
  createChatGatewayInstance,
  runGatewayCli,
} from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:reconnect-automations";
const reset = { mode: "daily", atHour: 0 } as const;
const freshPrompt = "List every automation after reconnecting.";
const onlineQueuedPrompt = "List every automation after the active reply finishes.";
const queuedPrompt = "List automations from this offline queued request.";
const restoredPrompt = "List automations from this restored document.";
const retryPrompt = "List automations after an explicit retry.";
const prompts = [freshPrompt, onlineQueuedPrompt, queuedPrompt, restoredPrompt, retryPrompt];
const foreignJobName = "Automation created outside this conversation";
type Inventory = { scope: string; jobs: Array<{ id: string; name: string }> };
type Input = { type?: string; name?: string; call_id?: string; output?: string };
type Frame = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  error?: { code?: string; message?: string };
};

async function startProvider() {
  const failures: string[] = [];
  const inventories: Inventory[] = [];
  const handlers = new Set<Promise<void>>();
  let step = 0;
  const firstReply = createDeferred();
  const owned = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const handler = (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const body: { model: string; input?: Input[] } = JSON.parse(
            (await buffer(request)).toString("utf8"),
          );
          if (body.model === "metadata") {
            writeOpenAiResponsesText(response, {
              text: "Reconnect automation proof",
              messageId: "metadata",
              responseId: "metadata",
            });
            return;
          }
          expect(body.model).toBe("operator");
          const currentStep = step++;
          expect(currentStep).toBeLessThan(prompts.length * 2);
          if (currentStep % 2 === 0) {
            expect(JSON.stringify(body.input)).toContain(prompts[currentStep / 2]);
            writeToolCall(response, "automations", { action: "list", includeDisabled: true });
            return;
          }
          const call = body.input?.findLast(
            (item) => item.type === "function_call" && item.name === "automations",
          );
          expect(call?.call_id).toBeTruthy();
          const output = body.input?.findLast(
            (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
          )?.output;
          expect(typeof output).toBe("string");
          const inventory: Inventory = JSON.parse(output!);
          inventories.push(inventory);
          if (currentStep === 1) {
            await firstReply.promise;
          }
          writeOpenAiResponsesText(response, {
            text: `Verified inventory ${inventories.length}: ${inventory.scope}.`,
            messageId: `inventory-${inventories.length}`,
            responseId: `inventory-${inventories.length}`,
          });
        })();
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          (error: unknown) => {
            failures.push(String(error));
            handlers.delete(handler);
            response.destroy();
          },
        );
      }),
  });
  return {
    port: owned.claim.port,
    failures,
    inventories,
    releaseFirstReply: () => firstReply.resolve(),
    close: () =>
      runQaGatewayFixture(async () => {
        firstReply.resolve();
        owned.listener.closeAllConnections();
        await Promise.allSettled(handlers);
        await owned.releaseListener();
      }, owned.claim.release),
  };
}

let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Real Gateway automation authority after browser reconnect",
  startServerBeforeBrowser: true,
  resources: { run: async () => {}, retainedState: () => instance?.stateDir },
  async startServer() {
    provider = await startProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "reconnect-automations",
        entrypoint: ["dist/index.js"],
        provider: "automation-fixture",
        identity: "Automation fixture",
        model: "operator",
        apiKey: "synthetic-automation-fixture-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: ["operator", "metadata"].map((id) => ({ id, name: id })),
        agents: { ownership: "explicit" },
        defaults: {
          utilityModel: "automation-fixture/metadata",
          models: {
            "automation-fixture/operator": { params: { transport: "sse" } },
            "automation-fixture/metadata": { params: { transport: "sse" } },
          },
        },
        config: {
          update: { checkOnStart: false },
          session: { reset },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          plugins: { allow: ["openai"] },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "automation-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-automation-fixture-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: ["operator", "metadata"].map((id) => ({ id, name: id })),
              },
            },
          },
        },
      });
      ensureGatewayOwnerProfile("Synthetic automation administrator", { env: instance.env });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

const rpc = async (method: string, params: Record<string, unknown>) =>
  JSON.parse(await callGateway(instance, method, params));

suite.define(() => {
  it("preserves fresh administrator inventory while queued, restored and retried input stays caller-scoped", async () => {
    const foreignJob: { id: string } = await rpc("cron.add", {
      name: foreignJobName,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Synthetic job, never scheduled" },
      delivery: { mode: "none" },
    });
    await rpc("sessions.create", { key: sessionKey, agentId: "main", permissionMode: "full" });
    await instance.stopGateway();
    const scope = { sessionKey, agentId: "main", env: instance.env };
    const entry = expectDefined(loadSessionEntryReadOnly(scope), "created session");
    const expiredAt = Date.now() - 48 * 60 * 60 * 1000;
    const stale = {
      ...entry,
      updatedAt: expiredAt,
      sessionStartedAt: expiredAt,
      lastInteractionAt: expiredAt,
    };
    // Seed only while offline; startGateway closes parent database handles before boot.
    replaceSessionEntrySync(scope, stale);
    expect(evaluateSessionFreshness({ ...stale, now: Date.now(), policy: reset })).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
    await instance.startGateway();
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sent: Frame[] = [];
      let reconnectGate = createDeferred();
      reconnectGate.resolve();
      let rejectRetryAttempt = true;
      let retryRequestId: string | undefined;
      let retryRejection: Frame["error"];
      let dropConnection: (() => void) | undefined;
      const socketUrl = new URL(suite.server.baseUrl);
      socketUrl.protocol = "ws:";
      await page.routeWebSocket(`${socketUrl.origin}/**`, async (socket) => {
        await reconnectGate.promise;
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString()) as Frame;
          sent.push(frame);
          if (
            frame.method === "chat.send" &&
            frame.params?.message === retryPrompt &&
            rejectRetryAttempt
          ) {
            rejectRetryAttempt = false;
            retryRequestId = frame.id;
            // Schema validation rejects this even when the active-run mode is steer.
            server.send(
              JSON.stringify({
                ...frame,
                params: { ...frame.params, expectedLeafEntryId: 0 },
              }),
            );
          } else {
            server.send(message);
          }
        });
        server.onMessage((message) => {
          const frame = JSON.parse(message.toString()) as Frame;
          if (retryRequestId && frame.id === retryRequestId && frame.ok === false) {
            retryRejection = frame.error;
          }
          socket.send(message);
        });
        dropConnection = () => {
          void socket.close({ code: 1012, reason: "synthetic browser reconnect" });
        };
      });
      await pairControlUiPage(page, (args) => runGatewayCli(instance, args));
      await page.goto(suite.server.baseUrl + "settings/appearance");
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await waitForControlUiGatewayReady(page);
      const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
      await composer.waitFor();
      await page.waitForFunction(() => {
        const pane = document.querySelector<HTMLElement & { state?: ChatPageHost }>(
          "openclaw-chat-pane",
        );
        return Boolean(pane?.state?.currentSessionId) && !pane?.state?.chatLoading;
      });
      const send = page.getByRole("button", { name: "Send message", exact: true });
      const disconnect = async () => {
        reconnectGate = createDeferred();
        expect(dropConnection).toBeDefined();
        dropConnection?.();
        await waitForControlUiGatewayReconnecting(page);
      };
      const completed = async (count: number) => {
        await expect.poll(() => provider.failures).toEqual([]);
        await expect.poll(() => provider.inventories.length).toBe(count);
        await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor({
          state: "detached",
        });
      };
      try {
        await disconnect();
        reconnectGate.resolve();
        await waitForControlUiGatewayReady(page);
        await composer.fill(freshPrompt);
        await send.click();
        await expect.poll(() => provider.inventories.length).toBe(1);
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({
          sessionId: stale.sessionId,
          sessionStartedAt: stale.sessionStartedAt,
          lifecycleRevision: stale.lifecycleRevision,
        });
        const freshSend = sent.find(
          (frame) => frame.method === "chat.send" && frame.params?.message === freshPrompt,
        );
        expect(freshSend).toBeDefined();
        expect(provider.inventories[0]).toMatchObject({
          scope: "gateway",
          jobs: expect.arrayContaining([
            expect.objectContaining({ id: foreignJob.id, name: foreignJobName }),
          ]),
        });
        expect(freshSend?.params).toHaveProperty("__controlUiReconnectResume", "fresh");
        await composer.fill(onlineQueuedPrompt);
        await page.getByRole("button", { name: "Queue message", exact: true }).click();
        await expect
          .poll(async () =>
            (await readOutboxQueue(page)).some((item) => item.text === onlineQueuedPrompt),
          )
          .toBe(true);
        expect(sent.some((frame) => frame.params?.message === onlineQueuedPrompt)).toBe(false);
        provider.releaseFirstReply();
        await completed(2);
        // The next ordinary turn applies daily rollover after the reconnect-only resume.
        const rolled = loadSessionEntryReadOnly(scope);
        expect(rolled?.sessionId).toBe(stale.sessionId);
        expect(rolled?.sessionStartedAt).toBeGreaterThan(stale.sessionStartedAt);
        expect(rolled?.lifecycleRevision).not.toBe(stale.lifecycleRevision);
        expect(provider.inventories[1]).toMatchObject({
          scope: "gateway",
          jobs: expect.arrayContaining([
            expect.objectContaining({ id: foreignJob.id, name: foreignJobName }),
          ]),
        });
        expect(
          sent.find((frame) => frame.params?.message === onlineQueuedPrompt)?.params,
        ).not.toHaveProperty("__controlUiReconnectResume");

        await disconnect();
        await composer.fill(queuedPrompt);
        await send.click();
        expect(sent.some((frame) => frame.params?.message === queuedPrompt)).toBe(false);
        reconnectGate.resolve();
        await waitForControlUiGatewayReady(page);
        await completed(3);
        const queuedSend = sent.find(
          (frame) => frame.method === "chat.send" && frame.params?.message === queuedPrompt,
        );
        expect(queuedSend?.params).toMatchObject({ __controlUiReconnectResume: true });
        expect(provider.inventories[2]?.scope).toBe("caller");
        expect(provider.inventories[2]?.jobs).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: foreignJob.id })]),
        );
        // Reload the real document after durable admission, while reconnect is held.
        await disconnect();
        await composer.fill(restoredPrompt);
        await send.click();
        await expect
          .poll(async () =>
            (await readOutboxQueue(page)).some((item) => item.text === restoredPrompt),
          )
          .toBe(true);
        await page.reload();
        reconnectGate.resolve();
        await waitForControlUiGatewayReady(page);
        await completed(4);
        expect(
          sent.find(
            (frame) => frame.method === "chat.send" && frame.params?.message === restoredPrompt,
          )?.params,
        ).toMatchObject({ __controlUiReconnectResume: true });
        expect(provider.inventories[3]?.scope).toBe("caller");
        expect(JSON.stringify(provider.inventories[3])).not.toContain(foreignJob.id);
        expect(JSON.stringify(provider.inventories[3])).not.toContain(foreignJobName);

        // Retry an actual Gateway rejection through the visible recovery action.
        await disconnect();
        reconnectGate.resolve();
        await waitForControlUiGatewayReady(page);
        await composer.fill(retryPrompt);
        await send.click();
        await expect
          .poll(() => retryRejection)
          .toMatchObject({
            code: "INVALID_REQUEST",
            message: expect.stringContaining("expectedLeafEntryId"),
          });
        const retry = page.getByRole("button", { name: "Retry queued message", exact: true });
        await retry.waitFor();
        expect(provider.inventories).toHaveLength(4);
        await retry.click();
        await completed(5);
        const retrySends = sent.filter(
          (frame) => frame.method === "chat.send" && frame.params?.message === retryPrompt,
        );
        expect(retrySends).toHaveLength(2);
        expect(retrySends[1]?.params).toMatchObject({ __controlUiReconnectResume: true });
        expect(provider.inventories[4]?.scope).toBe("caller");
        expect(JSON.stringify(provider.inventories[4])).not.toContain(foreignJob.id);
        expect(JSON.stringify(provider.inventories[4])).not.toContain(foreignJobName);
        expect(provider.failures).toEqual([]);
      } finally {
        provider.releaseFirstReply();
        reconnectGate.resolve();
      }
    });
  });
});
