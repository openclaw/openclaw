import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Task-only proof: ordinary UI runs must not pay for another Gateway boot.
// baseline/fixed changes assertions only, never product behavior.
const variant = process.env.OPENCLAW_STEER_CUSTODY_PROOF;
const sessionKey = "agent:main:steer-custody-proof";
const correction = "Keep this correction queued until the active reply finishes.";
const viewport = { width: 393, height: 852 };
type History = { pendingInputs?: ChatPendingInputsPage; inputReceipts?: ChatInputReceipts };

/** Observe actual frames; never replace WebSocket, route responses, or retain auth. */
function observe(page: Page) {
  const frames: GatewayFrame[] = [];
  const requestIds = new Set<string>();
  const methods = new Set(["chat.send", "chat.history", "chat.abort"]);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame: GatewayFrame = JSON.parse(String(payload));
      if (frame.type === "req" && methods.has(frame.method)) {
        requestIds.add(frame.id);
        frames.push(frame);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame: GatewayFrame = JSON.parse(String(payload));
      if (
        (frame.type === "res" && requestIds.has(frame.id)) ||
        (frame.type === "event" &&
          ["chat", "sessions.changed", "session.message"].includes(frame.event) &&
          record(frame.payload)?.sessionKey === sessionKey)
      ) {
        frames.push(frame);
      }
    });
  });
  const requests = (method: string) =>
    frames.flatMap((frame, index) =>
      frame.type === "req" && frame.method === method ? [{ frame, index }] : [],
    );
  const response = (id: string) => frames.find((frame) => frame.type === "res" && frame.id === id);
  const events = (name: string, after: number) =>
    frames
      .slice(after)
      .flatMap((frame) => (frame.type === "event" && frame.event === name ? [frame.payload] : []));
  const responses = (method: string, after: number) =>
    requests(method).flatMap(({ frame, index }) => {
      const reply = index >= after ? response(frame.id) : undefined;
      return reply?.type === "res" && reply.ok ? [reply.payload] : [];
    });
  return { frames, requests, response, events, responses };
}

/** Use the paired browser's real RPC client for public fixture setup only. */
async function rpc(page: Page, method: string, params: Record<string, unknown>) {
  return evaluateControlUiContext(
    page,
    async (context, request) => {
      const client = context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Paired Gateway client missing");
      }
      return client.request(request.method, request.params);
    },
    { method, params },
  );
}

describe.skipIf(!variant)("Task proof: actual pending follow-up custody", () => {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;
  const suite = createControlUiE2eSuite({
    name: "Mobile pending follow-up through a real Gateway",
    startServerBeforeBrowser: true,
    async startServer() {
      if (variant !== "baseline" && variant !== "fixed") {
        throw new Error("Set OPENCLAW_STEER_CUSTODY_PROOF to baseline or fixed");
      }
      provider = await startScrollInferenceFixture();
      const close = () =>
        runQaGatewayFixture(
          () => instance?.cleanup(),
          () => provider.close(),
        );
      try {
        instance = await createChatGatewayInstance({
          name: "steer-custody-real-gateway",
          provider: "scroll-fixture",
          identity: "Queue proof",
          model: "echo",
          apiKey: "synthetic-scroll-fixture-key",
          baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
          models: [{ id: "echo", name: "Local synthetic inference" }],
          config: {
            messages: { queue: { mode: "followup", byChannel: { webchat: "followup" } } },
          },
        });
        await instance.startGateway();
        return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
      } catch (error) {
        return runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });

  async function verifyCustody() {
    await suite.withPage(
      { viewport, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const wire = observe(page);
        await page.addInitScript(() =>
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          ),
        );
        await pairFixture(page, instance);
        await page.goto(new URL("settings/appearance", suite.server.baseUrl).href);
        await waitForControlUiGatewayReady(page);
        await page.locator("[data-settings-follow-up-mode]").selectOption("server");
        await page.locator("[data-settings-send-shortcut]").selectOption("enter");
        await rpc(page, "sessions.create", {
          key: sessionKey,
          agentId: "main",
          label: "Deferred steering proof",
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await assertServedUi(page, suite.server.baseUrl);
        const { pane, composer, send, stop } = chatControls(page);
        const active = provider.plan();
        await composer.fill("Investigate shared chat custody and wait for my correction.");
        await send.click();
        await expect.poll(provider.requests).toBe(active.index);
        await active.append("The original reply is active while I check the shared queue.");
        await pane
          .getByRole("paragraph")
          .filter({
            hasText: "The original reply is active while I check the shared queue.",
          })
          .waitFor();
        await stop.waitFor();
        await composer.fill(correction);
        const before = wire.frames.length;
        await composer.press("Enter");
        await expect.poll(() => wire.requests("chat.send").length).toBe(2);
        const sent = wire.requests("chat.send")[1]!.frame;
        expect(sent.params).toMatchObject({
          sessionKey,
          message: correction,
        });
        expect(record(sent.params)?.queueMode).toBe("followup");
        const runId = record(sent.params)?.idempotencyKey;
        if (typeof runId !== "string") {
          throw new Error("Actual steer idempotency key missing");
        }
        await expect.poll(() => wire.response(sent.id)).toMatchObject({ ok: true });
        // Do not issue a manual history request before the visual assertion: production
        // settlement/history refresh must fix placement without later assistant output.
        await expect
          .poll(() => wire.responses("chat.history", before))
          .toContainEqual(
            expect.objectContaining({
              pendingInputs: expect.objectContaining({
                items: expect.arrayContaining([
                  expect.objectContaining({ runId, state: "queued" }),
                ]),
              }),
            }),
          );
        const queued = pane.locator(".chat-queue__item", { hasText: correction });
        const bubble = pane.locator(".chat-group.user", { hasText: correction });
        await expect.poll(() => queued.count()).toBe(variant === "fixed" ? 1 : 0);
        await expect.poll(() => bubble.count()).toBe(variant === "fixed" ? 0 : 1);
        expect(await stop.isVisible()).toBe(true);
        expect(provider.requests()).toBe(1);
        expect(provider.failures).toEqual([]);
        const activeRunId = record(wire.requests("chat.send")[0]!.frame.params)?.idempotencyKey;
        expect(
          wire
            .events("chat", before)
            .filter(
              (payload) =>
                record(payload)?.runId === activeRunId &&
                ["delta", "final", "error", "aborted"].includes(String(record(payload)?.state)),
            ),
        ).toEqual([]);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => queued.count()).toBe(1);
        await expect.poll(() => bubble.count()).toBe(0);
        expect(wire.requests("chat.send")).toHaveLength(2);
        expect(provider.requests()).toBe(1);
        const custody = (await rpc(page, "chat.history", {
          sessionKey,
          inputRunIds: [runId],
        })) as History;
        expect(
          custody.pendingInputs?.items.filter(
            (item) => item.runId === runId && item.state === "queued",
          ),
        ).toHaveLength(1);
        expect(custody.inputReceipts).toContainEqual(
          expect.objectContaining({ runId, state: "pending" }),
        );
        // Stop through production UI before fixture shutdown, never finish the held
        // inference and accidentally execute the queued correction during cleanup.
        await stop.click();
        await expect.poll(() => wire.requests("chat.abort").length).toBe(1);
        const abort = wire.requests("chat.abort")[0]!.frame;
        await expect.poll(() => wire.response(abort.id)).toMatchObject({ ok: true });
      },
    );
  }

  suite.define(() => {
    it(
      "keeps an admitted follow-up in Queue while the original inference remains held",
      (test) =>
        suite.runScenario(test, {
          retainedState: () => instance.stateDir,
          run: verifyCustody,
        }),
      120000,
    );
  });
});
