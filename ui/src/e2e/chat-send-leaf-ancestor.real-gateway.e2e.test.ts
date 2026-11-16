import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { callGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const heldPrompt = "Draft the release note.";
const answers: Record<string, string> = {
  [heldPrompt]: "Release note drafted.",
  "Also mention the new flag.": "Flag mentioned.",
  "Plan A": "Plan A ready.",
  "Plan B": "Plan B ready.",
  "Plan C": "Plan C ready.",
  "Ship it.": "Shipped.",
};
const switchedBranches = /switched branches/;

/** Runtime context can follow the prompt, so pick the scripted prompt the user items mention last. */
function lastPrompt(input: unknown): string {
  const items = Array.isArray(input) ? (input as Record<string, unknown>[]) : [];
  const text = items
    .filter((item) => item.role === "user")
    .map((item) => JSON.stringify(item.content))
    .join("\n");
  const found = Object.keys(answers)
    .map((key) => ({ key, at: text.lastIndexOf(key) }))
    .filter(({ at }) => at >= 0)
    .toSorted((left, right) => right.at - left.at)[0];
  return found?.key ?? text;
}

/** Only inference is scripted; the held prompt keeps its turn running until released. */
async function startProvider() {
  const heldStarted = createDeferred();
  const release = createDeferred();
  const prompts: string[] = [];
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
          const body = JSON.parse((await buffer(request)).toString()) as { input?: unknown };
          const prompt = lastPrompt(body.input);
          prompts.push(prompt);
          if (prompt === heldPrompt) {
            heldStarted.resolve();
            await release.promise;
          }
          writeOpenAiResponsesText(response, {
            text: answers[prompt] ?? "Unexpected prompt.",
            messageId: `message_${prompts.length}`,
            responseId: `response_${prompts.length}`,
          });
        })().catch(() => response.destroy());
      }),
  });
  return {
    port: reserved.claim.port,
    prompts,
    release: () => release.resolve(),
    waitHeld: (signal: AbortSignal) => withinTest(heldStarted.promise, signal),
    async close() {
      release.resolve();
      reserved.listener.closeAllConnections();
      await reserved.releaseListener();
      await reserved.claim.release();
    },
  };
}

type Frame = { type?: string; id?: string; method?: string; params?: unknown; ok?: boolean };

/** Records chat.send results and can withhold Gateway events so a pane keeps its stale view. */
async function routeGatewaySocket(page: Page, port: number) {
  const sends = new Map<string, { params: Record<string, unknown>; ok?: boolean }>();
  const state = { withholdEvents: false };
  await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      if (frame.type === "req" && frame.method === "chat.send" && frame.id) {
        sends.set(frame.id, { params: frame.params as Record<string, unknown> });
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      if (frame.type === "res" && frame.id && sends.has(frame.id)) {
        sends.get(frame.id)!.ok = frame.ok;
      }
      if (state.withholdEvents && frame.type === "event") {
        return;
      }
      socket.send(message);
    });
  });
  return {
    state,
    sendFor: (message: string) =>
      [...sends.values()].find((send) => send.params.message === message),
  };
}

type HistoryMessage = { role?: string; content?: unknown; ["__openclaw"]?: { id?: string } };

async function historyEntryId(instance: OpenClawTestInstance, sessionKey: string, text: string) {
  const history = JSON.parse(
    await callGateway(instance, "chat.history", { sessionKey, limit: 50 }),
  ) as { messages: HistoryMessage[] };
  const found = history.messages.find((message) => JSON.stringify(message.content).includes(text));
  const id = found?.["__openclaw"]?.id;
  expect(id, `history entry for ${text}`).toBeTruthy();
  return id!;
}

describe("chat.send leaf precondition through a real Gateway", () => {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startProvider>>;
  const suite = createControlUiE2eSuite({
    name: "Chat send leaf ancestor real Gateway",
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
          name: "chat-send-leaf-ancestor",
          provider: "leaf-fixture",
          identity: "Project assistant",
          model: "local",
          apiKey: "synthetic-leaf-fixture-key",
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

  async function openSession(page: Page, sessionKey: string, label: string) {
    await page.addInitScript(() =>
      localStorage.setItem(
        "openclaw:control-ui:community-invite:v2",
        JSON.stringify({ dismissedAtMs: 1770000000000 }),
      ),
    );
    await callGateway(instance, "sessions.create", { key: sessionKey, agentId: "main", label });
    await pairFixture(page, instance);
    await page.goto(new URL("settings/appearance", suite.server.baseUrl).href);
    await waitForControlUiGatewayReady(page);
    await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await waitForControlUiGatewayReady(page);
    await assertServedUi(page, suite.server.baseUrl);
    return chatControls(page);
  }

  suite.define(() => {
    it("delivers a message queued during a turn once that turn ends", (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: (signal) =>
          suite.withPage(
            { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
            async ({ page }) => {
              const socket = await routeGatewaySocket(page, instance.port);
              const sessionKey = "agent:main:leaf-queued";
              const { pane, composer, send, stop } = await openSession(
                page,
                sessionKey,
                "Release note",
              );
              await composer.fill(heldPrompt);
              await send.click();
              await provider.waitHeld(signal);
              await stop.waitFor();
              const followUp = "Also mention the new flag.";
              await composer.fill(followUp);
              await composer.press("Enter");
              await pane.locator(".chat-group.user", { hasText: followUp }).waitFor();
              provider.release();
              const delivered = pane.getByRole("paragraph").filter({ hasText: "Flag mentioned." });
              const refused = page.getByText(switchedBranches).first();
              await delivered.or(refused).waitFor({ timeout: 30_000 });
              await page.screenshot({
                path: path.join(suite.artifactDir, "queued.png"),
              });
              await writeFile(
                path.join(suite.artifactDir, "queued.json"),
                JSON.stringify({ prompts: provider.prompts, send: socket.sendFor(followUp) }),
              );
              expect(await refused.count()).toBe(0);
              await delivered.waitFor();
              expect(socket.sendFor(followUp)?.ok).toBe(true);
              expect(provider.prompts).toEqual([heldPrompt, followUp]);
            },
          ),
      }));

    it("refuses a send from a pane that still shows the branch before a switch", (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: () =>
          suite.withPage(
            { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
            async ({ page }) => {
              const socket = await routeGatewaySocket(page, instance.port);
              const sessionKey = "agent:main:leaf-switch";
              const { pane, composer, send } = await openSession(page, sessionKey, "Plans");
              const turn = async (prompt: string) => {
                await composer.fill(prompt);
                await send.click();
                await pane.getByRole("paragraph").filter({ hasText: answers[prompt] }).waitFor();
              };
              await turn("Plan A");
              await turn("Plan B");
              const planBLeaf = await historyEntryId(instance, sessionKey, "Plan B ready.");
              const planBUser = await historyEntryId(instance, sessionKey, '"Plan B"');
              await callGateway(instance, "sessions.rewind", { sessionKey, entryId: planBUser });
              await expect
                .poll(() => pane.getByText("Plan B ready.").count(), { timeout: 15_000 })
                .toBe(0);
              await composer.fill("");
              await turn("Plan C");
              const planCLeaf = await historyEntryId(instance, sessionKey, "Plan C ready.");
              // Another client switches back to the Plan B branch; this pane keeps showing Plan C.
              socket.state.withholdEvents = true;
              await callGateway(instance, "sessions.branches.switch", {
                sessionKey,
                leafEntryId: planBLeaf,
              });
              const prompts = provider.prompts.length;
              await composer.fill("Ship it.");
              await send.click();
              const refused = page.getByText(switchedBranches).first();
              await refused.waitFor({ timeout: 30_000 });
              await page.screenshot({
                path: path.join(suite.artifactDir, "switch.png"),
              });
              socket.state.withholdEvents = false;
              expect(socket.sendFor("Ship it.")?.ok).toBe(false);
              expect(provider.prompts.length).toBe(prompts);
              expect(socket.sendFor("Ship it.")?.params.expectedLeafEntryId).toBe(planCLeaf);
            },
          ),
      }));
  });
});
