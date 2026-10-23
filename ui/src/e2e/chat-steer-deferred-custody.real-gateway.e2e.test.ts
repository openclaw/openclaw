import path from "node:path";
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
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import {
  assertFixtureSecretsAbsent,
  assertServedUi,
  chatControls,
  pairFixture,
} from "./chat-lifecycle.test-support.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Task-only visual proof: ordinary UI runs must not pay for another Gateway boot.
// baseline/fixed changes assertions and artifact labels only, never product behavior.
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

describe.skipIf(!variant)("Task proof: actual deferred steering custody", () => {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;
  let artifactDir: string;
  const suite = createControlUiE2eSuite({
    name: "Mobile deferred steering through a real Gateway",
    startServerBeforeBrowser: true,
    async startServer() {
      if (variant !== "baseline" && variant !== "fixed") {
        throw new Error("Set OPENCLAW_STEER_CUSTODY_PROOF to baseline or fixed");
      }
      artifactDir = createControlUiE2eArtifactDir("steer-custody-real-gateway-" + variant);
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
        const capture = async (stage: string) => {
          await assertFixtureSecretsAbsent(page, instance, "synthetic-scroll-fixture-key");
          await page.screenshot({ path: path.join(artifactDir, stage + ".png") });
        };
        await page.addInitScript(() =>
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          ),
        );
        await pairFixture(page, instance);
        await page.goto(new URL("settings/appearance", suite.server.baseUrl).href);
        await waitForControlUiGatewayReady(page);
        await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
        await page.locator("[data-settings-send-shortcut]").selectOption("enter");
        await rpc(page, "sessions.create", {
          key: sessionKey,
          agentId: "main",
          label: "Deferred steering proof",
          toolOverrides: { webSearch: true },
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
        // The real running backend freezes its tool fingerprint. A supported public
        // policy edit changes the next input's fingerprint, genuinely rejecting steering.
        // No test hook changes injection availability or manufactures custody/events.
        await rpc(page, "sessions.patch", {
          key: sessionKey,
          toolOverrides: { webSearch: false },
        });
        await composer.fill(correction);
        await capture("01-before-steer");
        const before = wire.frames.length;
        await composer.press("Control+Enter");
        await expect.poll(() => wire.requests("chat.send").length).toBe(2);
        const sent = wire.requests("chat.send")[1]!.frame;
        expect(sent.params).toMatchObject({
          sessionKey,
          message: correction,
          queueMode: "steer",
        });
        const runId = record(sent.params)?.idempotencyKey;
        if (typeof runId !== "string") {
          throw new Error("Actual steer idempotency key missing");
        }
        await expect.poll(() => wire.response(sent.id)).toMatchObject({ ok: true });
        // Pre-ACK rejection has no warning log. Prove disposition through the
        // authoritative receipt and automatic history refresh below instead.
        await expect
          .poll(() => wire.events("sessions.changed", before))
          .toContainEqual(expect.objectContaining({ reason: "agent.input.settled" }));
        // Do not issue a manual history request before the visual assertion: production
        // settlement/history refresh must fix placement without later assistant output.
        await expect
          .poll(() => wire.responses("chat.history", before))
          .toContainEqual(
            expect.objectContaining({
              pendingInputs: expect.objectContaining({
                queuedCount: 1,
                items: expect.arrayContaining([expect.objectContaining({ runId, queued: true })]),
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
        await capture("02-authoritative-followup-" + variant);
        const custody = (await rpc(page, "chat.history", {
          sessionKey,
          inputRunIds: [runId],
        })) as History;
        expect(
          custody.pendingInputs?.items.filter((item) => item.runId === runId && item.queued),
        ).toHaveLength(1);
        expect(custody.pendingInputs?.queuedCount).toBe(1);
        expect(custody.inputReceipts).toContainEqual({
          runId,
          state: "pending",
          queued: true,
        });
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
      "keeps one rejected steer in follow-up custody while the original inference remains held",
      (test) =>
        suite.runScenario(test, {
          retainedState: () => instance.stateDir,
          run: verifyCustody,
        }),
      120000,
    );
  });
});
