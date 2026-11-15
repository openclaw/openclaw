import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { writeToolCallResponse } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { callGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const variant = process.env.OPENCLAW_STEER_NOW_PROOF;
const sessionKey = "agent:main:steer-send-now";
const prompt = "Check the sample project, then wait for my correction.";
const correction = "Focus on the startup error first.";
const answer = "I interrupted the check and will focus on the startup error.";

/** Only inference is scripted. The Gateway executes and cancels a real foreground process. */
async function startProvider() {
  const started = createDeferred();
  const closed = createDeferred();
  const failure = createDeferred<never>();
  void failure.promise.catch(() => {});
  let held: ServerResponse | undefined;
  let requests = 0;
  let processClosed = false;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.url === "/held") {
            held = response;
            response.once("close", () => {
              processClosed = true;
              closed.resolve();
            });
            started.resolve();
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse((await buffer(request)).toString()) as { input?: unknown };
          requests++;
          if (requests === 1) {
            const source = `require("node:http").get("http://127.0.0.1:${reserved.claim.port}/held", r => r.resume())`;
            const item = {
              type: "function_call",
              id: "fc_check",
              call_id: "call_check",
              name: "exec",
              arguments: JSON.stringify({
                command: `node -e '${source}'`,
                host: "gateway",
                awaitResults: true,
                timeoutSeconds: variant === "fallback" ? 300 : 120,
              }),
            };
            writeToolCallResponse(response, item, "response_check", 1, 1);
            return;
          }
          expect(requests).toBe(2);
          expect(processClosed, "next inference must wait for physical command cleanup").toBe(true);
          const input = JSON.stringify(body.input);
          expect(input).toContain("Interrupted by the user");
          expect(input.split(correction)).toHaveLength(2);
          writeOpenAiResponsesText(response, {
            text: answer,
            messageId: "message_corrected",
            responseId: "response_corrected",
          });
        })().catch((error: unknown) => {
          failure.reject(error);
          response.destroy();
        });
      }),
  });
  return {
    port: reserved.claim.port,
    requests: () => requests,
    waitStarted: (signal: AbortSignal) =>
      withinTest(Promise.race([started.promise, failure.promise]), signal),
    waitClosed: (signal: AbortSignal) =>
      withinTest(Promise.race([closed.promise, failure.promise]), signal),
    async close() {
      held?.destroy();
      reserved.listener.closeAllConnections();
      await reserved.releaseListener();
      await reserved.claim.release();
    },
  };
}

describe.skipIf(!variant)("Task proof: Send now through a real Gateway", () => {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startProvider>>;
  const suite = createControlUiE2eSuite({
    name: "Send now real Gateway",
    startServerBeforeBrowser: true,
    async startServer() {
      if (variant !== "baseline" && variant !== "fixed" && variant !== "fallback") {
        throw new Error("OPENCLAW_STEER_NOW_PROOF must be baseline, fixed, or fallback");
      }
      provider = await startProvider();
      const close = () =>
        runQaGatewayFixture(
          () => instance?.cleanup(),
          () => provider.close(),
        );
      try {
        instance = await createChatGatewayInstance({
          name: "steer-send-now-proof",
          provider: "steer-fixture",
          identity: "Project assistant",
          model: "local",
          apiKey: "synthetic-steer-fixture-key",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [{ id: "local", name: "Local synthetic inference" }],
          config: {
            update: { checkOnStart: false },
            tools: {
              profile: "full",
              codeMode: false,
              toolSearch: false,
              exec: { host: "gateway", mode: "full" },
            },
          },
        });
        ensureGatewayOwnerProfile("Synthetic Viewer", { env: instance.env });
        await instance.startGateway();
        await callGateway(instance, "users.setAvatar", {
          profileId: "gateway-owner",
          mime: "image/png",
          avatarBase64: (await readFile("ui/public/apple-touch-icon.png")).toString("base64"),
        });
        return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
      } catch (error) {
        return runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });
  suite.define(() => {
    it(
      "keeps the user bubble and interrupts its running tool for exactly one correction delivery",
      (test) =>
        suite.runScenario(test, {
          retainedState: () => instance.stateDir,
          run: (signal) =>
            suite.withPage(
              { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
              async ({ page }) => {
                const wire = observeBackgroundWorkRpc(page, signal);
                await page.addInitScript(() =>
                  localStorage.setItem(
                    "openclaw:control-ui:community-invite:v2",
                    JSON.stringify({ dismissedAtMs: 1770000000000 }),
                  ),
                );
                await callGateway(instance, "sessions.create", {
                  key: sessionKey,
                  agentId: "main",
                  label: "Sample project",
                });
                await pairFixture(page, instance);
                await page.goto(new URL("settings/appearance", suite.server.baseUrl).href);
                await waitForControlUiGatewayReady(page);
                await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
                await page.locator('[data-test-id="send-shortcut-enter"]').click();
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
                await waitForControlUiGatewayReady(page);
                await assertServedUi(page, suite.server.baseUrl);
                const { pane, composer, send, stop } = chatControls(page);
                await composer.fill(prompt);
                await send.click();
                await provider.waitStarted(signal);
                await composer.fill(correction);
                const steerStartedAt = performance.now();
                await composer.press("Control+Enter");
                const accepted = await wire.waitFor(
                  (rpc) =>
                    rpc.request.method === "chat.send" &&
                    (rpc.request.params as { message?: string }).message === correction,
                );
                expect(accepted.response.ok).toBe(true);
                const steerRunId = (accepted.request.params as { idempotencyKey: string })
                  .idempotencyKey;
                expect(provider.requests()).toBe(1);
                const bubble = pane.locator(".chat-group.user", { hasText: correction });
                await bubble.waitFor();
                const link = bubble.getByRole("button", { name: "Send now", exact: true });
                if (variant !== "baseline") {
                  await link.waitFor();
                } else {
                  expect(await link.count()).toBe(0);
                }
                const frame = await takeControlUiScreenshotFrame(
                  page,
                  bubble,
                  [bubble.getByText(correction, { exact: true })],
                  { animations: "disabled", scrollTo: bubble, elements: [bubble] },
                );
                await writeFile(path.join(suite.artifactDir, `${variant}-pending.png`), frame.png);
                await writeFile(
                  path.join(suite.artifactDir, `${variant}-bubble.png`),
                  frame.elements[0]!.png,
                );
                if (variant === "baseline") {
                  await stop.click();
                  await provider.waitClosed(signal);
                  return;
                }
                if (variant === "fallback") {
                  await wire.waitFor((rpc) => {
                    const history = rpc.response.payload as ChatHistoryResult | undefined;
                    return (
                      rpc.request.method === "chat.history" &&
                      Boolean(
                        history?.pendingInputs?.items.some(
                          (input) => input.runId === steerRunId && input.queued,
                        ),
                      )
                    );
                  });
                  expect(performance.now() - steerStartedAt).toBeGreaterThanOrEqual(120_000);
                  await link.waitFor();
                  expect(provider.requests()).toBe(1);
                  const fallbackFrame = await takeControlUiScreenshotFrame(page, bubble, [link], {
                    animations: "disabled",
                    scrollTo: bubble,
                  });
                  await writeFile(
                    path.join(suite.artifactDir, "fallback-queued.png"),
                    fallbackFrame.png,
                  );
                }
                await link.click();
                const sentNow = await wire.waitFor((rpc) => rpc.request.method === "chat.steerNow");
                expect(sentNow.request.params).toMatchObject({ sessionKey, runId: steerRunId });
                expect(sentNow.response).toMatchObject({
                  ok: true,
                  payload: { status: "interrupted" },
                });
                await provider.waitClosed(signal);
                await pane.getByRole("paragraph").filter({ hasText: answer }).waitFor();
                await stop.waitFor({ state: "hidden" });
                await expect.poll(() => link.count()).toBe(0);
                expect(await bubble.count()).toBe(1);
                expect(provider.requests()).toBe(2);
                const final = await takeControlUiScreenshotFrame(
                  page,
                  bubble,
                  [bubble.getByText(correction, { exact: true })],
                  { animations: "disabled", scrollTo: bubble, elements: [bubble] },
                );
                await writeFile(path.join(suite.artifactDir, "fixed-injected.png"), final.png);
              },
            ),
        }),
      variant === "fallback" ? 240000 : 120000,
    );
  });
});
