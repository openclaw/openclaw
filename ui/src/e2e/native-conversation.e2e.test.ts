import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { installNativeEmbed, installNativeWebChrome } from "./native-nav.test-support.ts";
import { catalog } from "./native-plugin-ui.test-support.ts";

const suite = createChatFlowE2eSuite();
const viewport = { width: 1180, height: 820 };
type ConversationTestWindow = Window &
  typeof globalThis & {
    conversationMessages: Record<string, unknown>[];
    windowDragMessages: { type: "window-drag" }[];
    actionMenuReceipts: { requestId: unknown; expanded: string | null }[];
    dashboardResponse?: "rejected" | "throw";
    __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__: { documentId: string };
  };
const messages = (page: Page) =>
  page.evaluate(() => (window as ConversationTestWindow).conversationMessages);
async function installConversationHost(page: Page, features?: string[]) {
  await page.addInitScript((requestedFeatures) => {
    Object.assign(window, {
      __OPENCLAW_NATIVE_EMBED__: {
        platform: "macos",
        formFactor: "desktop",
        surface: "conversation",
      },
      __OPENCLAW_NATIVE_CONVERSATION__: {
        contract: 1,
        ...(requestedFeatures ? { features: requestedFeatures } : {}),
      },
      conversationMessages: [],
      windowDragMessages: [],
      actionMenuReceipts: [],
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
              if (message.type === "command-result") {
                host.actionMenuReceipts.push({
                  requestId: message.requestId,
                  expanded:
                    document
                      .querySelector(
                        ".chat-pane-cache__pane--visible .chat-header-session-menu__trigger",
                      )
                      ?.getAttribute("aria-expanded") ?? null,
                });
              }
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
  }, features);
}

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
      await installConversationHost(page);
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
      expect(first?.capabilities).toEqual(["navigate", "presentation", "focus-composer"]);
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
      expect((await messages(page)).some((message) => message.type === "session-facts")).toBe(
        false,
      );
    });
  });

  it("publishes composer metadata for another session without exposing its draft", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await installConversationHost(page, ["session-facts-v1", "unknown-fixture-feature"]);
      await installMockGateway(page, {
        sessions: ["main", "draft-b"].map((name) => ({
          key: `agent:main:${name}`,
          kind: "direct",
          label: name,
        })),
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const composer = page.locator(
        ".chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea",
      );
      await composer.waitFor();
      expect((await messages(page))[0]?.capabilities).toEqual([
        "navigate",
        "presentation",
        "focus-composer",
        "session-facts-v1",
      ]);
      const latestFacts = async () =>
        (await messages(page)).findLast((message) => message.type === "session-facts");
      const sessionB = { agentId: "main", sessionKey: "agent:main:draft-b" };
      await command(page, "navigate", sessionB, "draft-b");
      const privateDraft = "Only the web composer may read this unsent draft.";
      await composer.fill(privateDraft);
      await expect.poll(latestFacts).toMatchObject({
        sessions: expect.arrayContaining([
          { ...sessionB, hasComposerDraft: true, outboxAttentionCount: 0 },
        ]),
      });
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:main" },
        "show-a-with-b-draft",
      );
      expect(await composer.inputValue()).toBe("");
      expect(await latestFacts()).toMatchObject({
        sessions: expect.arrayContaining([
          { ...sessionB, hasComposerDraft: true, outboxAttentionCount: 0 },
        ]),
      });
      await command(page, "navigate", sessionB, "clear-draft-b");
      expect(await composer.inputValue()).toBe(privateDraft);
      await composer.fill("");
      await expect
        .poll(async () => {
          const snapshot = await latestFacts();
          return Array.isArray(snapshot?.sessions)
            ? snapshot.sessions.some(
                (row: Record<string, unknown>) =>
                  row.sessionKey === sessionB.sessionKey && row.hasComposerDraft === true,
              )
            : null;
        })
        .toBe(false);
      const snapshots = (await messages(page)).filter(
        (message) => message.type === "session-facts",
      );
      const documentId = (await messages(page))[0]?.documentId;
      let revision = 0;
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({ contract: 1, documentId });
        expect(typeof snapshot.revision).toBe("number");
        expect(snapshot.revision).toBeGreaterThan(revision);
        revision = Number(snapshot.revision);
        expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(65_536);
        if (Array.isArray(snapshot.sessions)) {
          expect(snapshot.sessions.length).toBeLessThanOrEqual(64);
          for (const row of snapshot.sessions) {
            expect(Object.keys(requireRecord(row)).toSorted()).toEqual([
              "agentId",
              "hasComposerDraft",
              "outboxAttentionCount",
              "sessionKey",
            ]);
          }
        }
      }
      expect(JSON.stringify(await messages(page))).not.toContain(privateDraft);
    });
  });

  it("opens the selected session's web actions before acknowledging and leaves execution in web", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await installConversationHost(page, ["session-actions-v1"]);
      const sessionB = { agentId: "main", sessionKey: "agent:main:worker-b" };
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "plugins.controlUi.list",
          "plugins.controlUi.report",
        ],
        sessions: [
          { key: "agent:main:main", kind: "direct", label: "Session A" },
          {
            key: sessionB.sessionKey,
            sessionId: "worker-b-incarnation",
            agentId: "main",
            kind: "direct",
            label: "Worker B",
            hasActiveRun: false,
            placement: {
              state: "active",
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
              environmentId: "worker:fixture",
              activeOwnerEpoch: 1,
              workerBundleHash: "a".repeat(64),
              workspaceBaseManifestRef: "fixture-manifest",
              remoteWorkspaceDir: "/workspace/worker-b",
            },
          },
        ],
        methodResponses: {
          "plugins.controlUi.list": catalog("session-actions"),
          "plugins.controlUi.report": { ok: true },
          "fixture.sessionAction": { ok: true },
          "sessions.reclaim": { ok: true },
        },
      });
      await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: `export default { id: "ui-fixture", activate(host) {
            host.ui.registerAction({ id: "session-proof", label: "Run session proof", placement: "session",
              run: context => context.host.request("fixture.sessionAction", { sessionKey: context.sessionKey, agentId: context.agentId }) });
            host.ui.registerAction({ id: "session-error", label: "Fail session proof", placement: "session",
              run() { throw new Error("Synthetic session action failed."); } });
          } };`,
        }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const pane = page.locator(".chat-pane-cache__pane--visible");
      await pane.locator(".agent-chat__composer-combobox textarea").waitFor();
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      expect((await messages(page))[0]?.capabilities).toEqual([
        "navigate",
        "presentation",
        "focus-composer",
        "session-actions-v1",
      ]);
      await command(page, "open-session-actions", sessionB, "open-worker-b");
      expect(
        await page.evaluate(() =>
          (window as ConversationTestWindow).actionMenuReceipts.find(
            (receipt) => receipt.requestId === "open-worker-b",
          ),
        ),
      ).toEqual({ requestId: "open-worker-b", expanded: "true" });
      expect((await messages(page)).findLast((message) => message.type === "state")).toMatchObject({
        context: sessionB,
      });
      const menu = pane.locator("openclaw-chat-header-session-menu");
      await menu.getByRole("menuitem", { name: "Run session proof", exact: true }).waitFor();
      await menu.getByRole("menuitem", { name: "Stop cloud worker…", exact: true }).waitFor();
      expect(await gateway.getRequests("fixture.sessionAction")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      await menu.getByRole("menuitem", { name: "Run session proof", exact: true }).click();
      expect(requireRecord((await gateway.waitForRequest("fixture.sessionAction")).params)).toEqual(
        sessionB,
      );
      await command(page, "open-session-actions", sessionB, "open-plugin-error");
      await menu.getByRole("menuitem", { name: "Fail session proof", exact: true }).click();
      await page.getByText("Synthetic session action failed.", { exact: true }).waitFor();
      await command(page, "open-session-actions", sessionB, "open-stop-cancel");
      await menu.getByRole("menuitem", { name: "Stop cloud worker…", exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      await command(page, "open-session-actions", sessionB, "open-stop-confirm");
      await gateway.deferNext("sessions.reclaim");
      await menu.getByRole("menuitem", { name: "Stop cloud worker…", exact: true }).click();
      await dialog.getByRole("button", { name: "Stop worker", exact: true }).click();
      expect(requireRecord((await gateway.waitForRequest("sessions.reclaim")).params)).toEqual({
        key: sessionB.sessionKey,
        agentId: sessionB.agentId,
      });
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:main" },
        "navigate-during-reclaim",
      );
      await gateway.resolveDeferred("sessions.reclaim", { ok: true });
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(1);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect((await messages(page)).some((message) => message.type === "session-facts")).toBe(
        false,
      );
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
