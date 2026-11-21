import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { callGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const reply = "Noted.";

/** Only inference is scripted; every turn answers with the same short reply. */
async function startProvider() {
  let turns = 0;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          await buffer(request);
          turns += 1;
          writeOpenAiResponsesText(response, {
            text: reply,
            messageId: `message_${turns}`,
            responseId: `response_${turns}`,
          });
        })().catch(() => response.destroy());
      }),
  });
  return {
    port: reserved.claim.port,
    async close() {
      reserved.listener.closeAllConnections();
      await reserved.releaseListener();
      await reserved.claim.release();
    },
  };
}

type Frame = { type?: string; id?: string; method?: string; params?: unknown; payload?: unknown };

/** Records the Gateway's answers to the invitation's bounded session-use reads. */
function recordSessionUse(page: Page) {
  const pending = new Set<string>();
  const counts: number[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as Frame;
      const params = frame.params as { promptedByMe?: boolean } | undefined;
      if (frame.method === "sessions.list" && params?.promptedByMe === true && frame.id) {
        pending.add(frame.id);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as Frame;
      if (frame.type === "res" && frame.id && pending.delete(frame.id)) {
        counts.push((frame.payload as { totalCount?: number } | undefined)?.totalCount ?? -1);
      }
    });
  });
  return counts;
}

describe("Community invitation through a real Gateway", () => {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startProvider>>;
  const suite = createControlUiE2eSuite({
    name: "Community invitation real Gateway",
    startServerBeforeBrowser: true,
    async startServer() {
      provider = await startProvider();
      const close = () =>
        runQaGatewayFixture(
          () => instance?.cleanup(),
          () => provider.close(),
        );
      try {
        instance = await createChatGatewayInstance({
          name: "community-invite-sessions",
          entrypoint: ["dist/index.js"],
          provider: "invite-fixture",
          identity: "Project assistant",
          model: "local",
          apiKey: "synthetic-invite-fixture-key",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [{ id: "local", name: "Local synthetic inference" }],
          config: {
            update: { checkOnStart: false },
            tools: { profile: "minimal", codeMode: false, toolSearch: false },
          },
        });
        ensureGatewayOwnerProfile("Synthetic Viewer", { env: instance.env });
        await instance.startGateway();
        return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
      } catch (error) {
        return runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });

  suite.define(() => {
    it("waits for three prompted conversations and keeps a dismissal after reload", (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: () =>
          suite.withPage(
            { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
            async ({ page }) => {
              const card = page.locator(".community-invite-card");
              const counts = recordSessionUse(page);
              const latest = () => counts.at(-1);
              const keys = ["first", "second", "third"].map((name) => `agent:main:invite-${name}`);
              for (const [index, key] of keys.entries()) {
                await callGateway(instance, "sessions.create", {
                  key,
                  agentId: "main",
                  label: `Conversation ${index + 1}`,
                });
              }
              await pairFixture(page, instance);
              const open = async (key: string) => {
                const reads = counts.length;
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
                await waitForControlUiGatewayReady(page);
                await assertServedUi(page, suite.server.baseUrl);
                await expect.poll(() => counts.length, { timeout: 30_000 }).toBeGreaterThan(reads);
                return chatControls(page);
              };
              const turn = async (controls: ReturnType<typeof chatControls>, message: string) => {
                const replies = await controls.pane.getByText(reply, { exact: true }).count();
                await controls.composer.fill(message);
                await controls.send.click();
                await expect
                  .poll(() => controls.pane.getByText(reply, { exact: true }).count(), {
                    timeout: 30_000,
                  })
                  .toBe(replies + 1);
              };

              let controls = await open(keys[0]!);
              expect(latest()).toBe(0);
              expect(await card.count()).toBe(0);
              await page.screenshot({ path: path.join(suite.artifactDir, "first-open.png") });

              for (const message of ["One", "Two", "Three"]) {
                await turn(controls, message);
              }
              await expect.poll(latest, { timeout: 30_000 }).toBe(1);
              expect(await card.count()).toBe(0);

              await open(keys[0]!);
              expect(latest()).toBe(1);
              expect(await card.count()).toBe(0);

              controls = await open(keys[1]!);
              await turn(controls, "Second conversation");
              await expect.poll(latest, { timeout: 30_000 }).toBe(2);
              expect(await card.count()).toBe(0);
              await page.screenshot({ path: path.join(suite.artifactDir, "two-sessions.png") });

              controls = await open(keys[2]!);
              expect(latest()).toBe(2);
              expect(await card.count()).toBe(0);
              await turn(controls, "Third conversation");
              // The third distinct conversation reveals the card in place, without reloading.
              await card.waitFor({ timeout: 30_000 });
              expect(latest()).toBe(3);
              expect(await page.getByRole("dialog").count()).toBe(0);
              await page.screenshot({ path: path.join(suite.artifactDir, "third-session.png") });

              await card.getByRole("button", { name: "Dismiss and don't show again" }).click();
              await card.waitFor({ state: "detached" });
              const reads = counts.length;
              await page.reload();
              await waitForControlUiGatewayReady(page);
              await chatControls(page).composer.waitFor();
              expect(await card.count()).toBe(0);
              expect(counts.length).toBe(reads);
              await page.screenshot({ path: path.join(suite.artifactDir, "dismissed-reload.png") });
            },
          ),
      }));
  });
});
