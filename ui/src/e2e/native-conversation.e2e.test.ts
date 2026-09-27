import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { installNativeEmbed, installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createChatFlowE2eSuite();
const viewport = { width: 1180, height: 820 };
type ConversationTestWindow = Window &
  typeof globalThis & {
    conversationMessages: Record<string, unknown>[];
    windowDragMessages: { type: "window-drag" }[];
    dashboardResponse?: "rejected" | "throw";
    __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__: { documentId: string };
  };
const messages = (page: Page) =>
  page.evaluate(() => (window as ConversationTestWindow).conversationMessages);
async function command(
  page: Page,
  type: string,
  payload: unknown,
  requestId: string,
  expected: { ok: boolean; error?: string } = { ok: true },
) {
  await page.evaluate(
    (commandDetails) => {
      const host = window as ConversationTestWindow;
      window.dispatchEvent(
        new CustomEvent("openclaw:native-conversation-command", {
          detail: {
            contract: 1,
            documentId: host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"].documentId,
            ...commandDetails,
          },
        }),
      );
    },
    { type, payload, requestId },
  );
  await expect
    .poll(async () =>
      (await messages(page)).find(
        (message) => message.type === "command-result" && message.requestId === requestId,
      ),
    )
    .toMatchObject(expected);
}

async function headerLeadingInset(page: Page) {
  return page.locator(".chat-pane-cache__pane--visible .chat-pane__header").evaluate((header) => {
    const leading = header.querySelector(".chat-pane__header-leading");
    if (!leading) {
      throw new Error("Chat header leading region is missing");
    }
    return leading.getBoundingClientRect().left - header.getBoundingClientRect().left;
  });
}

suite.define(() => {
  it("keeps a single web conversation with in-page native navigation and Dashboard handoff", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("native-conversation")
        : undefined;
      await page.addInitScript(() => {
        Object.assign(window, {
          __OPENCLAW_NATIVE_EMBED__: {
            platform: "macos",
            formFactor: "desktop",
            surface: "conversation",
          },
          __OPENCLAW_NATIVE_CONVERSATION__: { contract: 1 },
          conversationMessages: [],
          windowDragMessages: [],
          webkit: {
            messageHandlers: {
              openclawWindowDrag: {
                postMessage(message: { type: "window-drag" }) {
                  (window as ConversationTestWindow).windowDragMessages.push(message);
                },
              },
              openclawConversation: {
                postMessage(message: Record<string, unknown>) {
                  const host = window as ConversationTestWindow;
                  host.conversationMessages.push(message);
                  if (message.type === "open-dashboard") {
                    if (host.dashboardResponse === "rejected") {
                      return Promise.resolve({ ok: false, error: "Dashboard unavailable" });
                    }
                    if (host.dashboardResponse === "throw") {
                      return Promise.reject(new Error("Dashboard unavailable"));
                    }
                  }
                  return Promise.resolve({ ok: true });
                },
              },
            },
          },
        });
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.setProperty("--openclaw-native-titlebar-height", "52px");
        });
      });
      const linkedUrl = controlUiSessionUrl(suite.server.baseUrl, "agent:main:linked");
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        sessions: ["main", "next", "linked"].map((name) => ({
          key: `agent:main:${name}`,
          label: name,
          kind: "direct",
        })),
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Conversation ready. [Linked conversation](${linkedUrl}) · [Settings](/settings?section=general) · [Notes](notes.txt)`,
              },
            ],
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            root: "/workspace",
            sessionKey: "agent:main:main",
            file: {
              name: "notes.txt",
              path: "notes.txt",
              workspacePath: "notes.txt",
              content: "Conversation workspace notes.",
              contentEncoding: "utf8",
              kind: "read",
              missing: false,
              previewKind: "text",
            },
          },
        },
      });
      await page.addInitScript((storageKey) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            chatSplitLayout: {
              columns: [
                {
                  id: "c1",
                  panes: [{ id: "p1", sessionKey: "agent:main:main" }],
                  paneWeights: [1],
                },
                {
                  id: "c2",
                  panes: [{ id: "p2", sessionKey: "agent:main:extra" }],
                  paneWeights: [1],
                },
              ],
              columnWeights: [0.5, 0.5],
              activePaneId: "p2",
            },
          }),
        );
      }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const pane = page.locator(".chat-pane-cache__pane--visible");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      await pane.getByText("Conversation ready.", { exact: false }).waitFor();
      expect(
        await page
          .locator(
            "openclaw-app-sidebar, openclaw-app-topbar, .shell-nav, .native-embed-header, .settings-sidebar__agent",
          )
          .count(),
      ).toBe(0);
      expect(await page.locator(".chat-split-view__cell").count()).toBe(1);
      const header = pane.locator(".chat-pane__header");
      expect(await header.isVisible()).toBe(true);
      expect(await pane.locator(".chat-thread").isVisible()).toBe(true);
      expect(await headerLeadingInset(page)).toBe(12);
      expect(await header.boundingBox()).toMatchObject({ y: 0, height: 52 });
      expect(await pane.locator(".chat-thread").boundingBox()).toMatchObject({ y: 52 });
      const leadingBox = await header.locator(".chat-pane__header-leading").boundingBox();
      expect(leadingBox!.y + leadingBox!.height / 2).toBe(26);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "conversation-titlebar.png") });
      }
      const dragMessages = () =>
        page.evaluate(() => (window as ConversationTestWindow).windowDragMessages);
      await header.hover({ position: { x: viewport.width / 2, y: 26 } });
      await page.mouse.down();
      expect(await dragMessages()).toEqual([{ type: "window-drag" }]);
      await page.mouse.up();
      const sessionMenu = header.locator(".chat-header-session-menu__trigger");
      await sessionMenu.click();
      await expect.poll(() => sessionMenu.getAttribute("aria-expanded")).toBe("true");
      expect(await dragMessages()).toEqual([{ type: "window-drag" }]);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 700, height: viewport.height });
      for (const [height, expected] of [
        ["64px", 64],
        ["", 52],
      ] as const) {
        await page.evaluate((value) => {
          document.documentElement.style.setProperty("--openclaw-native-titlebar-height", value);
        }, height);
        await expect.poll(() => header.boundingBox()).toMatchObject({ y: 0, height: expected });
        expect(await pane.locator(".chat-thread").boundingBox()).toMatchObject({ y: expected });
      }
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--openclaw-native-titlebar-height", "52px");
      });
      const first = (await messages(page))[0];
      expect(first).toMatchObject({ type: "ready", contract: 1, surface: "conversation" });
      const documentId = first?.documentId;
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const initialUrl = page.url();
      await pane.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
      expect(
        requireRecord((await gateway.waitForRequest("sessions.files.get")).params),
      ).toMatchObject({
        sessionKey: "agent:main:main",
        path: "notes.txt",
      });
      const fileView = pane.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      await expect
        .poll(() => fileView.locator(".cm-content").textContent())
        .toContain("Conversation workspace notes.");
      expect(page.url()).toBe(initialUrl);
      expect((await messages(page)).filter((message) => message.type === "open-dashboard")).toEqual(
        [],
      );
      await pane.getByRole("button", { name: "Close tab: notes.txt", exact: true }).click();
      await fileView.waitFor({ state: "detached" });
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "conversation-initial.png") });
      }
      await composer.fill("Verify the web composer");
      await pane.getByRole("button", { name: "Send message", exact: true }).click();
      const request = requireRecord((await gateway.waitForRequest("chat.send")).params);
      expect(request.message).toBe("Verify the web composer");
      expect(request.sessionKey).toBe("agent:main:main");
      await gateway.emitChatFinal({
        runId: requireString(request.idempotencyKey, "run id"),
        text: "Web composer verified.",
      });
      await pane
        .locator(".chat-thread-inner")
        .getByText("Web composer verified.", { exact: true })
        .waitFor();
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:next" },
        "navigate-1",
      );
      await expect
        .poll(async () => (await messages(page)).findLast((message) => message.type === "state"))
        .toMatchObject({ context: { agentId: "main", sessionKey: "agent:main:next" } });
      const navigationMessages = await messages(page);
      const navigationResult = navigationMessages.findIndex(
        (message) => message.type === "command-result" && message.requestId === "navigate-1",
      );
      const targetState = navigationMessages.findIndex(
        (message) =>
          message.type === "state" &&
          requireRecord(message.context).sessionKey === "agent:main:next",
      );
      expect(targetState).toBeGreaterThan(-1);
      expect(targetState).toBeLessThan(navigationResult);
      await pane.getByRole("link", { name: "Linked conversation", exact: true }).click();
      await expect
        .poll(async () =>
          (await messages(page)).findLast((message) => message.type === "route-changed"),
        )
        .toMatchObject({ agentId: "main", sessionKey: "agent:main:linked" });
      const conversationUrl = page.url();
      await pane.getByRole("link", { name: "Settings", exact: true }).click();
      await expect
        .poll(async () =>
          (await messages(page)).findLast((message) => message.type === "open-dashboard"),
        )
        .toMatchObject({ path: "/settings", search: "?section=general" });
      expect(page.url()).toBe(conversationUrl);
      for (const response of ["rejected", "throw"] as const) {
        await page.evaluate((replyMode) => {
          (window as ConversationTestWindow).dashboardResponse = replyMode;
        }, response);
        await pane.getByRole("link", { name: "Settings", exact: true }).click();
        const toast = page.locator(".app-toast");
        await expect
          .poll(() => toast.textContent())
          .toContain("Couldn't open that page in the Dashboard");
        expect(page.url()).toBe(conversationUrl);
        expect(await composer.isVisible()).toBe(true);
        await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
        await toast.waitFor({ state: "detached" });
      }
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect((await messages(page)).every((message) => message.documentId === documentId)).toBe(
        true,
      );
      await command(page, "presentation", { visible: false, active: false }, "hide");
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("true");
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:next" },
        "hidden-navigate",
      );
      await command(page, "presentation", { visible: true, active: false }, "show-inactive");
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("false");
      expect(await composer.isVisible()).toBe(true);
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:linked" },
        "inactive-navigate",
      );
      await expect
        .poll(async () => (await messages(page)).findLast((message) => message.type === "state"))
        .toMatchObject({ context: { agentId: "main", sessionKey: "agent:main:linked" } });
      expect(await pane.getAttribute("aria-hidden")).toBe("false");
      expect(await composer.isVisible()).toBe(true);
      await command(page, "focus-composer", {}, "inactive-focus", {
        ok: false,
        error: "unavailable",
      });
      await command(page, "presentation", { visible: true, active: true }, "activate");
      await command(page, "focus-composer", {}, "focus");
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await headerLeadingInset(page)).toBe(12);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "conversation-navigated.png") });
      }
    });
  });

  it.each(["browser", "dashboard", "ios"] as const)(
    "preserves %s chat and settings presentation",
    async (mode) => {
      await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
        if (mode === "ios") {
          await installNativeEmbed(page, { platform: "ios", formFactor: "pad" });
        } else if (mode === "dashboard") {
          await installNativeWebChrome(page);
        }
        await installMockGateway(page, {
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Ordinary conversation." }] },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await page.locator(".chat-pane__header").isVisible()).toBe(true);
        expect(await page.locator(".native-embed-header").count()).toBe(mode === "ios" ? 1 : 0);
        expect(await page.locator(".settings-sidebar__agent").count()).toBe(mode === "ios" ? 1 : 0);
        expect(
          await page.evaluate(() => "__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__" in window),
        ).toBe(false);
        if (mode === "ios") {
          await page.locator(".native-embed-header__back").click();
          await page
            .locator(".native-embed-header")
            .getByText("Settings", { exact: true })
            .waitFor();
          expect(new URL(page.url()).pathname).toBe("/settings");
        } else {
          expect(await headerLeadingInset(page)).toBe(12);
          expect(await page.locator(".chat-pane__header").boundingBox()).toMatchObject({
            y: 0,
            height: mode === "dashboard" ? 52 : 48,
          });
          expect(await page.locator("openclaw-app-sidebar").isVisible()).toBe(true);
        }
      });
    },
  );
});
