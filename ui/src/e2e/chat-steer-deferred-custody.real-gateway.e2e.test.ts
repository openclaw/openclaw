import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
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
  const frames: Array<{ direction: "sent" | "received"; frame: GatewayFrame }> = [];
  const requestIds = new Set<string>();
  const methods = new Set([
    "sessions.create",
    "sessions.patch",
    "chat.send",
    "chat.history",
    "chat.startup",
    "chat.abort",
  ]);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame: GatewayFrame = JSON.parse(String(payload));
      if (frame.type === "req" && methods.has(frame.method)) {
        requestIds.add(frame.id);
        frames.push({ direction: "sent", frame });
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
        frames.push({ direction: "received", frame });
      }
    });
  });
  const requests = (method: string) =>
    frames.flatMap(({ frame }, index) =>
      frame.type === "req" && frame.method === method ? [{ frame, index }] : [],
    );
  const response = (id: string) =>
    frames.find(({ frame }) => frame.type === "res" && frame.id === id)?.frame;
  return { frames, requests, response };
}

/** Use the paired browser's real RPC client for public fixture setup only. */
async function rpc(page: Page, method: string, params: Record<string, unknown>) {
  return page.evaluate(
    async (request) => {
      const client = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
        "openclaw-app",
      )?.runtime?.context.gateway.snapshot.client;
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
  const proof: Record<string, unknown> = {
    variant,
    viewport,
    complete: false,
    transport:
      "production Gateway WebSocket, chat.send, dispatch and history; passive frame capture",
    inference: "credential-free loopback Responses fixture; NOT an external live provider",
    rejectionMechanism:
      "public sessions.patch changes webSearch overlay against the active frozen tool fingerprint",
    screenshots:
      "same scenario under separately built baseline/fixed source; stage labels are not source comparisons",
  };
  const saveProof = () =>
    writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
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
          async () => {
            await instance?.cleanup();
            proof.gatewayStopped = !instance?.child;
          },
          () => provider.close(),
          async () => {
            proof.providerFailures = provider.failures;
            proof.providerRequests = provider.requests();
            await saveProof();
          },
        );
      try {
        instance = await createOpenClawTestInstance({
          name: "steer-custody-real-gateway",
          env: { VITEST: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
          config: {
            gateway: { controlUi: { enabled: true } },
            cron: { enabled: false },
            agents: {
              defaults: {
                model: "scroll-fixture/echo",
                modelPolicy: { allow: ["scroll-fixture/*"] },
              },
              entries: { main: { identity: { name: "Queue proof" } } },
            },
            models: {
              catalogRefresh: { enabled: false },
              providers: {
                "scroll-fixture": {
                  api: "openai-responses",
                  apiKey: "synthetic-scroll-fixture-key",
                  baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
                  models: [{ id: "echo", name: "Local synthetic inference" }],
                },
              },
            },
            messages: { queue: { mode: "followup", byChannel: { webchat: "followup" } } },
            plugins: { allow: [] },
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

  suite.define(() => {
    it("keeps one rejected steer in follow-up custody while the original inference remains held", async (test) => {
      await suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: async () => {
          await suite.withPage(
            { viewport, locale: "en-US", serviceWorkers: "block" },
            async ({ page, context }) => {
              const wire = observe(page);
              const runCli = async (args: string[]) => {
                const result = await instance.cli(args);
                expect(result.code, result.stderr).toBe(0);
                return result.stdout;
              };
              const capture = async (stage: string) => {
                const text = (await page.locator("body").textContent()) ?? "";
                for (const secret of [
                  instance.gatewayToken,
                  instance.hookToken,
                  instance.stateDir,
                  instance.homeDir,
                  "synthetic-scroll-fixture-key",
                ]) {
                  expect(
                    text.includes(secret),
                    "public screenshot must exclude fixture credentials and paths",
                  ).toBe(false);
                }
                expect(new URL(page.url()).hash).toBe("");
                await page.screenshot({ path: path.join(artifactDir, stage + ".png") });
              };
              try {
                await page.addInitScript(() =>
                  localStorage.setItem(
                    "openclaw:control-ui:community-invite:v2",
                    JSON.stringify({ dismissedAtMs: 1770000000000 }),
                  ),
                );
                await pairControlUiPage(page, runCli);
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
                const script = await page
                  .locator('script[type="module"][src]')
                  .first()
                  .getAttribute("src");
                expect(script).toMatch(/^\/assets\/.+\.js$/);
                const asset = await context.request.get(
                  new URL(script!, suite.server.baseUrl).href,
                );
                expect(asset.ok()).toBe(true);
                const served = await asset.body();
                expect(
                  served.equals(await readFile(path.join("dist/control-ui", script!.slice(1)))),
                ).toBe(true);
                proof.uiAsset = {
                  path: script,
                  sha256: createHash("sha256").update(served).digest("hex"),
                };

                const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
                const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
                const stop = pane.getByRole("button", { name: "Stop generating", exact: true });
                const active = provider.plan();
                await composer.fill("Investigate shared chat custody and wait for my correction.");
                await pane.getByRole("button", { name: "Send message", exact: true }).click();
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
                  .poll(() =>
                    wire.frames
                      .slice(before)
                      .some(
                        ({ frame }) =>
                          frame.type === "event" &&
                          frame.event === "sessions.changed" &&
                          record(frame.payload)?.reason === "agent.input.settled",
                      ),
                  )
                  .toBe(true);
                // Do not issue a manual history request before the visual assertion: production
                // settlement/history refresh must fix placement without later assistant output.
                await expect
                  .poll(() =>
                    wire.frames.slice(before).some(({ frame }) => {
                      if (
                        frame.type !== "res" ||
                        !frame.ok ||
                        !wire
                          .requests("chat.history")
                          .some(
                            (request) => request.frame.id === frame.id && request.index >= before,
                          )
                      ) {
                        return false;
                      }
                      const history = frame.payload as History;
                      return (
                        history.pendingInputs?.queuedCount === 1 &&
                        history.pendingInputs.items.some(
                          (item) => item.runId === runId && item.queued === true,
                        )
                      );
                    }),
                  )
                  .toBe(true);
                const queued = pane.locator(".chat-queue__item", { hasText: correction });
                const bubble = pane.locator(".chat-group.user", { hasText: correction });
                await expect.poll(() => queued.count()).toBe(variant === "fixed" ? 1 : 0);
                await expect.poll(() => bubble.count()).toBe(variant === "fixed" ? 0 : 1);
                expect(await stop.isVisible()).toBe(true);
                expect(provider.requests()).toBe(1);
                expect(provider.failures).toEqual([]);
                const activeRunId = record(
                  wire.requests("chat.send")[0]!.frame.params,
                )?.idempotencyKey;
                expect(
                  wire.frames
                    .slice(before)
                    .filter(
                      ({ frame }) =>
                        frame.type === "event" &&
                        frame.event === "chat" &&
                        record(frame.payload)?.runId === activeRunId &&
                        ["delta", "final", "error", "aborted"].includes(
                          String(record(frame.payload)?.state),
                        ),
                    ),
                ).toEqual([]);
                await capture("02-authoritative-followup-" + variant);
                const custody = (await rpc(page, "chat.history", {
                  sessionKey,
                  inputRunIds: [runId],
                })) as History;
                expect(
                  custody.pendingInputs?.items.filter(
                    (item) => item.runId === runId && item.queued,
                  ),
                ).toHaveLength(1);
                expect(custody.pendingInputs?.queuedCount).toBe(1);
                expect(custody.inputReceipts).toContainEqual({
                  runId,
                  state: "pending",
                  queued: true,
                });
                proof.custody = custody;
                proof.visible = {
                  queueItems: await queued.count(),
                  transcriptCopies: await bubble.count(),
                  stopVisible: await stop.isVisible(),
                };
                // Stop through production UI before fixture shutdown, never finish the held
                // inference and accidentally execute the queued correction during cleanup.
                await stop.click();
                await expect.poll(() => wire.requests("chat.abort").length).toBe(1);
                const abort = wire.requests("chat.abort")[0]!.frame;
                await expect.poll(() => wire.response(abort.id)).toMatchObject({ ok: true });
                proof.complete = true;
              } finally {
                // Only allowlisted application frames are retained; connect/auth never enter this log.
                proof.frames = wire.frames;
                // Actual application packets can contain synthetic workspace paths. Retain
                // sanitized bytes without ever persisting authentication or fixture secrets.
                let serialized = JSON.stringify(proof);
                for (const value of [
                  instance.gatewayToken,
                  instance.hookToken,
                  instance.stateDir,
                  instance.homeDir,
                  "synthetic-scroll-fixture-key",
                ]) {
                  serialized = serialized.replaceAll(value, "[fixture-redacted]");
                }
                Object.assign(proof, JSON.parse(serialized));
                await saveProof();
              }
            },
          );
        },
      });
    }, 120_000);
  });
});
