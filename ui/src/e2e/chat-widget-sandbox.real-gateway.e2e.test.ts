import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionsCreateResult } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { createCanvasDocument } from "../../../src/canvas/documents.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installWarmConnectIdentityGate,
  installWarmConnectSocketTrace,
} from "./warm-connect-socket.test-support.ts";

let instance: OpenClawTestInstance | undefined;
let client: Awaited<ReturnType<typeof connectChatGateway>> | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI widget sandbox with a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(gatewayOwner(), signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-widget-sandbox",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      },
      env: { OPENCLAW_SKIP_CANVAS_HOST: "0", OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
    });
    instance = owner;
    try {
      ensureGatewayOwnerProfile("Synthetic Viewer", { env: owner.env });
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

function gatewayOwner() {
  if (!instance) {
    throw new Error("Gateway fixture is not running");
  }
  return instance;
}

const browserOptions = {
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block" as const,
  permissions: ["local-network-access"],
};

function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown>) {
  if (!client) {
    throw new Error("Gateway fixture client is not connected");
  }
  return client.request<T>(method, params);
}

async function sessionUrl(key: string, face: "chat" | "dashboard") {
  const handoff = await cliJson(["dashboard", "--json"]);
  expect(typeof handoff.browserUrl).toBe("string");
  const url = new URL(controlUiSessionUrl(suite.server.baseUrl, key, face));
  url.hash = new URL(String(handoff.browserUrl)).hash;
  return url.toString();
}

function canvasDocument(title: string, body: string) {
  return withEnvAsync({ OPENCLAW_STATE_DIR: gatewayOwner().stateDir }, () =>
    createCanvasDocument({
      title,
      html: buildWidgetDocument(title, body),
      cspSandbox: "scripts",
    }),
  );
}

async function createSession(key: string, label: string) {
  const session = await rpc<SessionsCreateResult>("sessions.create", {
    key,
    agentId: "main",
    label,
  });
  expect(session.ok).toBe(true);
  expect(typeof session.sessionId).toBe("string");
  return String(session.sessionId);
}

function appendAssistant(sessionKey: string, sessionId: string, content: unknown[]) {
  return appendTranscriptMessage(
    { agentId: "main", sessionKey, sessionId, env: gatewayOwner().env },
    { message: { role: "assistant", content, timestamp: Date.now() } },
  );
}

async function cliJson(args: string[]): Promise<Record<string, unknown>> {
  const result = await gatewayOwner().cli(["--no-color", ...args]);
  expect(result, args.slice(0, 3).join(" ")).toMatchObject({ code: 0, signal: null });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "keeps one signed-in connection across warm %s reloads",
    { timeout: 120_000 },
    async (face) => {
      const key = `agent:main:dashboard:warm-connect-${face}`;
      const sessionId = await createSession(key, `Warm ${face} connection`);
      await rpc("sessions.patch", { key, boardFace: "dashboard" });
      await rpc("board.widget.put", {
        sessionKey: key,
        name: "warm-connect",
        title: "Warm connection proof",
        placement: { size: "full" },
        content: {
          kind: "html",
          html: buildWidgetDocument("Warm connection proof", "<h1>Cached connection proof</h1>"),
        },
      });
      for (let index = 0; index < 9; index++) {
        await appendAssistant(key, sessionId, [
          {
            type: "text",
            text:
              index === 8
                ? `Cached warm connection transcript.\n\n| Item | Value |\n| --- | --- |\n${Array.from({ length: 24 }, (_, row) => `| Synthetic ${row} | Stored value |`).join("\n")}\n\n[Linked mission](/chat/main/d0effac9)\n\n![Synthetic image](/apple-touch-icon.png)`
                : `Synthetic tall row ${index}.\n\n${"Cached paragraph.\n\n".repeat(12)}`,
          },
        ]);
      }
      const url = await sessionUrl(key, face);
      const observations: unknown[] = [];
      await suite.withPage(browserOptions, async ({ page }) => {
        await page.addInitScript(installWarmConnectSocketTrace);
        await page.addInitScript(installWarmConnectIdentityGate);
        await page.goto(url);
        if (await page.getByRole("link", { name: "Log in", exact: true }).isVisible()) {
          await enterControlUiSession(page);
        }
        await waitForControlUiGatewayReady(page);
        const transcript = page
          .getByText("Cached warm connection transcript.", { exact: false })
          .first();
        await transcript.waitFor();
        if (face === "dashboard") {
          await page
            .locator(".board-widget__frame")
            .contentFrame()
            .frameLocator("iframe")
            .getByRole("heading", { name: "Cached connection proof" })
            .waitFor();
        }
        await page.waitForFunction(() =>
          Object.keys(localStorage).some((storageKey) =>
            storageKey.startsWith("openclaw.control.bootRecord.v1:"),
          ),
        );
        for (let reload = 0; reload < 2; reload++) {
          await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
          await page.evaluate(persistColdLoadWarmState, {
            sessionKey: key,
            sidebarView: "sessions",
          } satisfies Parameters<typeof persistColdLoadWarmState>[0]);
          if (reload === 0) {
            await page.evaluate(() => sessionStorage.setItem("warm-connect-hold-identity", "1"));
          }
          await page.reload();
          if (reload === 0) {
            try {
              await page.waitForFunction(() => window.warmConnectIdentityPending === true);
              await transcript.waitFor();
              await page.getByRole("link", { name: "Linked mission", exact: true }).waitFor();
              observations.push({
                face,
                reload,
                stage: "cached-before-connect",
                trace: await page.evaluate(() => window.warmConnectSocketTrace),
              });
            } finally {
              await page.evaluate(() => window.releaseWarmConnectIdentity?.());
            }
          }
          await waitForControlUiGatewayReady(page);
          await transcript.waitFor();
          const trace = await page.evaluate(() => window.warmConnectSocketTrace);
          observations.push({ face, reload, trace });
          await writeFile(
            path.join(suite.artifactDir, `warm-connect-${face}.json`),
            JSON.stringify(observations, null, 2),
          );
          expect(trace, JSON.stringify(trace)).toMatchObject({
            sockets: 1,
            connects: 1,
            closeRequests: 0,
            closes: 0,
            dropped: 0,
          });
          expect(trace?.events.find((event) => event.direction === "send")?.method).toBe("connect");
        }
      });
    },
  );
  it("reads persisted Canvas bytes through an authenticated browser connection", async () => {
    const sessionKey = "agent:main:widget-live-proof";
    const sessionId = await createSession(sessionKey, "Synthetic widget proof");
    const { id: docId } = await canvasDocument(
      "Live widget proof",
      `<h1>Live widget proof</h1><label>Local note <input aria-label="Local note"></label>`,
    );
    const content = [
      {
        type: "text",
        text: `The synthetic widget is ready.\n[embed ref="${docId}" title="Live widget proof" height="320" /]`,
      },
    ];
    await appendAssistant(sessionKey, sessionId, content);
    const history = await rpc<{ messages: unknown[] }>("chat.history", {
      sessionKey,
      agentId: "main",
    });
    expect(history.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content })]),
    );
    const url = await sessionUrl(sessionKey, "chat");
    await suite.withPage(browserOptions, async ({ page }) => {
      const canvasReads: unknown[] = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const request = JSON.parse(payload.toString()) as { method?: string; params?: unknown };
          if (request.method === "canvas.document.view") {
            canvasReads.push(request.params);
          }
        });
      });
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
      await enterControlUiSession(page);
      await waitForControlUiGatewayReady(page);
      const frames = page.locator("openclaw-canvas-widget-view .chat-tool-card__preview-frame");
      const outer = frames.first();
      const inner = outer.contentFrame().frameLocator("iframe");
      await inner.getByRole("heading", { name: "Live widget proof" }).waitFor();
      await inner.getByRole("textbox", { name: "Local note" }).fill("Persisted bytes, isolated UI");
      expect(canvasReads).toEqual([{ docId }]);
      expect(await outer.getAttribute("src")).toContain("/mcp-app-sandbox");
      const opaque = await inner.locator("body").evaluate(() => {
        try {
          void window.top?.document;
          return false;
        } catch {
          return true;
        }
      });
      expect(opaque).toBe(true);
    });
  });

  it("retains a real dashboard, article position, and chat draft across navigation and Settings", async () => {
    const dashboardKey = "agent:main:daily-claw-retention";
    const chatKey = "agent:main:chat-navigation-retention";
    const widgetName = "daily-claw";
    const note = "Read the navigation story after lunch.";
    const draft = "Explain how retaining this dashboard preserves my reading position.";
    const articleHtml = (edition: string) =>
      buildWidgetDocument(
        "The Daily Claw",
        `<style>article{height:280px;overflow:auto}article p{min-height:48px}</style>
        <h1>The Daily Claw</h1><p id="edition">${edition}</p>
        <label>Reading note <input aria-label="Reading note"></label>
        <article aria-label="Daily Claw article" tabindex="0">
          ${Array.from({ length: 30 }, (_, index) => `<p>Story ${index + 1}: Synthetic engineering news for the navigation retention proof.</p>`).join("")}
        </article>`,
      );
    await createSession(dashboardKey, "The Daily Claw");
    await rpc("sessions.patch", { key: dashboardKey, boardFace: "dashboard" });
    const widgetParams = {
      sessionKey: dashboardKey,
      name: widgetName,
      title: "The Daily Claw",
      placement: { size: "full" },
    };
    await rpc("board.widget.put", {
      ...widgetParams,
      content: { kind: "html", html: articleHtml("Morning edition") },
    });
    const chatId = await createSession(chatKey, "Navigation proof chat");
    await appendAssistant(chatKey, chatId, [
      { type: "text", text: "Synthetic session ready for navigation." },
    ]);
    const url = await sessionUrl(dashboardKey, "dashboard");
    await suite.withPage(browserOptions, async ({ page }) => {
      const sessionLink = (key: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
        );
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      await waitForControlUiGatewayReady(page);
      const board = page.locator("openclaw-board-view").first();
      const outer = board.locator(
        `.board-widget[data-widget-name="${widgetName}"] .board-widget__frame`,
      );
      const inner = outer.contentFrame().frameLocator("iframe");
      const readingNote = inner.getByRole("textbox", { name: "Reading note" });
      const article = inner.getByRole("article", { name: "Daily Claw article" });
      await readingNote.fill(note);
      await article.evaluate((element) => {
        element.scrollTop = 480;
      });
      const articleScrollTop = await article.evaluate((element) => element.scrollTop);
      expect(articleScrollTop).toBeGreaterThan(0);
      const originalFrame = await outer.elementHandle();
      const originalBoard = await board.elementHandle();
      if (!originalFrame || !originalBoard) {
        throw new Error("Daily Claw frame and board were not mounted");
      }
      const expectRetainedArticle = async () => {
        expect(
          await outer.evaluate((element, previous) => element === previous, originalFrame),
        ).toBe(true);
        expect(await readingNote.inputValue()).toBe(note);
        expect(await article.evaluate((element) => element.scrollTop)).toBe(articleScrollTop);
      };
      const composer = page.locator(
        "openclaw-chat-pane.chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea",
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sessionLink(chatKey).click();
        await composer.waitFor();
        await expect.poll(() => sessionLink(chatKey).getAttribute("aria-current")).toBe("page");
        if (attempt === 0) {
          await composer.fill(draft);
        } else {
          expect(await composer.inputValue()).toBe(draft);
        }
        expect(await originalFrame.evaluate((element) => element.isConnected)).toBe(true);
        await expect
          .poll(() => originalBoard.evaluate((element) => Reflect.get(element, "active")))
          .toBe(false);
        await sessionLink(dashboardKey).click();
        await readingNote.waitFor();
        await expectRetainedArticle();
      }
      await page.locator("openclaw-app-sidebar .sidebar-identity-card").click();
      await page.locator('openclaw-app-sidebar [data-value="command:settings"]').click();
      await page.locator(".settings-sidebar__back").waitFor();
      const parked = {
        frameConnected: await originalFrame.evaluate((element) => element.isConnected),
        boardActive: await originalBoard.evaluate((element) => Reflect.get(element, "active")),
      };
      await page.locator(".settings-sidebar__back").click();
      await readingNote.waitFor();
      await expectRetainedArticle();
      expect(parked).toEqual({ frameConnected: true, boardActive: false });
      await sessionLink(chatKey).click();
      await composer.waitFor();
      expect(await composer.inputValue()).toBe(draft);
      await sessionLink(dashboardKey).click();
      await readingNote.waitFor();
      await rpc("board.widget.put", {
        ...widgetParams,
        content: {
          kind: "html",
          html: articleHtml("Afternoon edition: refreshed from the Gateway"),
        },
      });
      await inner
        .getByText("Afternoon edition: refreshed from the Gateway", { exact: true })
        .waitFor();
    });
  });
});
