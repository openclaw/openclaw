import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  timedText,
  expectCount,
  expectTextContains,
  expectText,
  chatFixture,
  composer as chatComposer,
  newChatPage,
  sessionRow,
} from "./chat-flow-fixtures.test-support.ts";
import {
  SESSION_DRAG_MIME,
  captureSessionAccessibilityProof,
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  sidebarSessionOrder,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { watchNavigationFollowIntent } from "./chat-navigation-follow.test-support.ts";
import { dockChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };

const distanceFromBottom = (thread: import("playwright").Locator) =>
  thread.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

async function readTopTranscriptAnchor(thread: import("playwright").Locator) {
  return thread.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-virtual-row-key]")];
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > top);
    return row
      ? { key: row.dataset.virtualRowKey ?? null, offset: row.getBoundingClientRect().top - top }
      : null;
  });
}

suite.define(() => {
  it("coalesces persisted same-session split panes during cold startup", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          chatSplitLayout: {
            activePaneId: "p1",
            columns: [1, 2].map((index) => ({
              id: `c${index}`,
              panes: [{ id: `p${index}`, sessionKey: "agent:main:session-a" }],
              paneWeights: [1],
            })),
            columnWeights: [0.5, 0.5],
          },
        }),
      );
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      subscriptionInitialHistory: false,
      deferredMethods: ["chat.startup", "chat.startup"],
      historyMessages: [timedText("assistant", "Shared cold startup proof.")],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    await expectCount(panes, 2, { timeout: 10_000 });
    await expect
      .poll(() =>
        panes.evaluateAll((nodes) =>
          nodes.map((node) =>
            Boolean(
              (node as HTMLElement & { state?: { chatLoading?: boolean } }).state?.chatLoading,
            ),
          ),
        ),
      )
      .toEqual([true, true]);
    // Loading is published before foreground subscription admission and RPC dispatch.
    await gateway.waitForRequest("chat.startup");
    expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

    await gateway.resolveDeferred("chat.startup");
    await expectCount(page.getByText("Shared cold startup proof."), 2);
    expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
  });

  it("retains scrolled and end-anchored sessions without history reloads", async () => {
    const { page } = await newChatPage(suite, { viewport: { height: 720, width: 1280 } });
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const messages = (label: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${label} message ${index}: ${"wrapped transcript content ".repeat(8)}`,
        timestamp: 1_000 + index,
        __openclaw: { seq: index + 1 },
      }));
    const response = (sessionKey: string, transcript: unknown[]) => ({
      messages: transcript,
      sessionId: `${sessionKey}:backing`,
      thinkingLevel: null,
    });
    const responseCases = (messagesA: unknown[], messagesB = messages("B", 30)) => ({
      cases: [
        { match: { sessionKey: sessionA }, response: response(sessionA, messagesA) },
        { match: { sessionKey: sessionB }, response: response(sessionB, messagesB) },
      ],
    });
    const initialMessagesA = messages("A", 70);
    const initialResponses = responseCases(initialMessagesA);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": initialResponses,
        "chat.startup": initialResponses,
        "sessions.list": chatSessionListResponse([
          sessionRow(sessionA, "Session A", 2, { sessionId: `${sessionA}:backing` }),
          sessionRow(sessionB, "Session B", 1, { sessionId: `${sessionB}:backing` }),
        ]),
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await waitForChatScrollIdle(page);
    await gateway.waitForRequest("agent.identity.get");
    const initialIdentityRequestCount = (await gateway.getRequests("agent.identity.get")).length;
    const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    await expectCount(thread, 1);
    expect(await distanceFromBottom(thread)).toBeLessThanOrEqual(8);
    await thread.evaluate((element) => {
      const transcript = element as HTMLElement;
      transcript.scrollTop = Math.floor((transcript.scrollHeight - transcript.clientHeight) / 3);
      transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitForChatScrollIdle(page);
    const storedAnchor = await readTopTranscriptAnchor(thread);
    expect(storedAnchor?.key).not.toBeNull();

    const sessionLink = (sessionKey: string) =>
      page.locator(
        `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
      );
    const finishFirstVisit = await watchNavigationFollowIntent(page, sessionB);
    await sessionLink(sessionB).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionB));
    await waitForChatScrollIdle(page);
    await finishFirstVisit(false);
    expect(await gateway.getRequests("agent.identity.get")).toHaveLength(
      initialIdentityRequestCount,
    );
    expect(await distanceFromBottom(thread)).toBeLessThanOrEqual(8);

    const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
    const finishReadingReturn = await watchNavigationFollowIntent(page, sessionA);
    await sessionLink(sessionA).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
    await waitForChatScrollIdle(page);
    expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequestsBeforeReturn);

    const restoredDistance = await distanceFromBottom(thread);
    const restoredAnchor = await readTopTranscriptAnchor(thread);
    expect(restoredAnchor?.key).toBe(storedAnchor?.key);
    expect(
      Math.abs((restoredAnchor?.offset ?? 0) - (storedAnchor?.offset ?? 0)),
      JSON.stringify({ restoredAnchor, storedAnchor }),
    ).toBeLessThanOrEqual(2);
    expect(restoredDistance).toBeGreaterThan(8);
    await finishReadingReturn(true);

    const historyRequestsBeforeEndReturn = (await gateway.getRequests("chat.history")).length;
    const finishEndReturn = await watchNavigationFollowIntent(page, sessionB);
    await sessionLink(sessionB).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionB));
    await waitForChatScrollIdle(page);
    expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequestsBeforeEndReturn);
    expect(await distanceFromBottom(thread)).toBeLessThanOrEqual(8);
    await finishEndReturn(false);
  });

  it("renders always-on pane headers without desktop topbar chrome", async () => {
    const { page, gateway } = await chatFixture(
      suite,
      {
        subscriptionInitialHistory: false,
        historyMessages: [timedText("assistant", "Split toolbar proof.")],
        methodResponses: { "sessions.list": chatSessionListResponse() },
        sessionKey: "agent:main:session-a",
      },
      { viewport: { height: 900, width: 1440 } },
    );

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    await page.getByText("Split toolbar proof.").waitFor({ timeout: 10_000 });

    // Desktop renders no topbar row: the sidebar owns navigation.
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

    const layout = page.locator(".chat-pane__identity-actions .chat-header-session-menu__trigger");
    await expect.poll(() => layout.isVisible()).toBe(true);
    await expectCount(page.locator(".chat-pane__header"), 1);
    const taskHeader = page.locator(".chat-pane__header");
    const regularHeaderPadding = await taskHeader.evaluate(
      (header) => getComputedStyle(header).paddingLeft,
    );
    const composer = chatComposer(page);
    await composer.fill("Keep this draft while docking beside native controls");
    const originalComposer = await composer.elementHandle();
    await page.evaluate(() => {
      document.documentElement.classList.add("openclaw-native-macos");
      document.querySelector(".shell")?.classList.add("shell--nav-collapsed");
    });
    await expect
      .poll(() =>
        page
          .locator(".chat-pane__header")
          .evaluate((header) => getComputedStyle(header).paddingLeft),
      )
      .toBe("90px");
    await openChatSidePanelType(page, "Files");
    await dockChatSidePanel(page, "left");
    const sideHeader = page.locator('[data-region-header="side"]');
    const filesTab = sideHeader.getByRole("tab", { name: "Files", exact: true });
    await filesTab.waitFor();
    await expect
      .poll(() => taskHeader.evaluate((header) => getComputedStyle(header).paddingLeft))
      .toBe(regularHeaderPadding);
    await expect
      .poll(() => filesTab.evaluate((tab) => tab.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(90);
    const taskHeaderBox = await taskHeader.boundingBox();
    const sideHeaderBox = await sideHeader.boundingBox();
    expect(taskHeaderBox?.y).toBeCloseTo(sideHeaderBox!.y, 0);
    expect(taskHeaderBox!.x).toBeGreaterThan(sideHeaderBox!.x);
    expect(
      await composer.evaluate((element, original) => element === original, originalComposer),
    ).toBe(true);
    expect(await composer.inputValue()).toBe(
      "Keep this draft while docking beside native controls",
    );
    await originalComposer?.dispose();
    await sideHeader.getByRole("button", { name: "Close Files", exact: true }).click();
    await filesTab.waitFor({ state: "detached" });
    await composer.fill("");
    await page.evaluate(() => {
      document.documentElement.classList.remove("openclaw-native-macos");
      document.querySelector(".shell")?.classList.remove("shell--nav-collapsed");
    });
    await page.setViewportSize({ height: 900, width: 1100 });
    await expect.poll(() => layout.isVisible()).toBe(true);
    await page.setViewportSize({ height: 900, width: 1440 });
    await expect
      .poll(() => layout.evaluate((node) => node.closest(".agent-chat__composer-shell") == null))
      .toBe(true);
    await page.locator("openclaw-chat-pane").evaluate((pane) => {
      Reflect.set(globalThis, "classicChatPane", pane);
    });
    const startupRequestsBeforeSplit = (await gateway.getRequests("chat.startup")).length;
    await gateway.deferNext("chat.startup");
    await selectChatLayoutAction(page, "Open split view");
    await expect
      .poll(async () => (await gateway.getRequests("chat.startup")).length)
      .toBeGreaterThan(startupRequestsBeforeSplit);

    // Each pane owns the same in-flow header in classic and split layouts.
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    const headers = page.locator(".chat-pane__header");
    await expectCount(panes, 2);
    await panes.last().getByText("Split toolbar proof.").waitFor();
    await expectCount(
      panes.last().locator('openclaw-panel-loading-skeleton[data-panel-skeleton="chat"]'),
      0,
    );
    await gateway.resolveDeferred("chat.startup");
    await expect
      .poll(() =>
        panes.first().evaluate((pane) => Reflect.get(globalThis, "classicChatPane") === pane),
      )
      .toBe(true);
    await expectCount(headers, 2);
    await expect
      .poll(async () => {
        const visible = await Promise.all((await headers.all()).map((pane) => pane.isVisible()));
        return visible.every(Boolean);
      })
      .toBe(true);
    // Each pane retains its own native session Actions; panel controls live in the frame.
    await expectCount(headers.first().locator("openclaw-chat-header-session-menu"), 1);
    await expectCount(page.locator(".chat-workspace-rail"), 0);

    const cells = page.locator(".chat-split-view__cell");
    const actionRows = headers.locator(".chat-pane__actions");
    const visibleActionLabels = () =>
      Promise.all(
        [0, 1].map((index) =>
          actionRows
            .nth(index)
            .getByRole("button")
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
        ),
      );
    const activeActions = expect.arrayContaining(["Details"]);
    await expect.poll(visibleActionLabels).toEqual([["Details"], activeActions]);
    expect(await headers.last().locator(".chat-header-session-menu__trigger").isVisible()).toBe(
      true,
    );
    for (const header of await headers.all()) {
      expect(await header.getByRole("button", { name: "Details", exact: true }).isEnabled()).toBe(
        true,
      );
    }

    // Activate through the composer; a retained hovercard can cover a pane-relative pixel.
    await panes.first().locator(".agent-chat__composer-combobox textarea").click();
    await expect.poll(() => cells.first().getAttribute("class")).toContain("--active");
    await expect.poll(visibleActionLabels).toEqual([activeActions, ["Details"]]);
    expect(await headers.first().locator(".chat-header-session-menu__trigger").isVisible()).toBe(
      true,
    );
    const paneEmphasis = await cells.evaluateAll((nodes) =>
      nodes.map((cell) => {
        const style = getComputedStyle(cell);
        return {
          active: cell.classList.contains("chat-split-view__cell--active"),
          boxShadow: style.boxShadow,
          filter: style.filter,
          opacity: style.opacity,
        };
      }),
    );
    expect(paneEmphasis).toEqual([
      { active: true, boxShadow: "none", filter: "none", opacity: "1" },
      { active: false, boxShadow: "none", filter: "saturate(0.45)", opacity: "1" },
    ]);

    const lastPane = page.locator(".chat-split-view__pane").last();
    await lastPane.locator(".agent-chat__composer-combobox textarea").click();
    await expect.poll(() => cells.last().getAttribute("class")).toContain("--active");
    await expect.poll(visibleActionLabels).toEqual([["Details"], activeActions]);
    expect(await headers.last().locator(".chat-header-session-menu__trigger").isVisible()).toBe(
      true,
    );
    const targetHeader = headers.first();
    const headerGeometry = await headers.evaluateAll((nodes) =>
      nodes.map((header) => {
        const owner = header.closest("openclaw-chat-pane");
        const main = owner?.querySelector('[data-region="main"]:not([hidden])');
        const frame = header.closest(".sidebar-region__header");
        if (!main || !frame) {
          throw new Error("Each task toolbar must have its frame and visible main content");
        }
        const toolbar = header.getBoundingClientRect();
        const headerFrame = frame.getBoundingClientRect();
        const content = main.getBoundingClientRect();
        return {
          height: toolbar.height,
          toggleReserve: headerFrame.right - toolbar.right,
          left: Math.abs(headerFrame.left - content.left),
          right: Math.abs(headerFrame.right - content.right),
          gap: Math.abs(toolbar.bottom - content.top),
        };
      }),
    );
    for (const geometry of headerGeometry) {
      expect(geometry.height).toBe(44);
      expect(geometry.toggleReserve).toBe(32);
      expect(Math.max(geometry.left, geometry.right, geometry.gap)).toBeLessThanOrEqual(1);
    }

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await dataTransfer.evaluate(
      (transfer, data) => {
        transfer.setData(data.mime, data.sessionKey);
      },
      { mime: SESSION_DRAG_MIME, sessionKey: "agent:main:session-b" },
    );
    const unrelatedTarget = page.locator(".chat-split-view");
    const unrelatedDrag = { bubbles: true, clientX: 0, clientY: 0, dataTransfer };
    await unrelatedTarget.dispatchEvent("dragenter", unrelatedDrag);
    await unrelatedTarget.dispatchEvent("dragover", unrelatedDrag);
    await expectCount(page.locator(".chat-split-view__drop-indicator"), 0);
    await unrelatedTarget.dispatchEvent("drop", unrelatedDrag);
    await expectCount(panes, 2);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:session-a"));

    // Start with no retained pane preview and target the visible header.
    const targetBox = await targetHeader.boundingBox();
    if (!targetBox) {
      throw new Error("expected the pane header to have a layout box");
    }
    const directHeaderDrag = {
      bubbles: true,
      clientX: targetBox.x + targetBox.width / 2,
      clientY: targetBox.y + targetBox.height / 2,
      dataTransfer,
    };
    await targetHeader.dispatchEvent("dragenter", directHeaderDrag);
    await targetHeader.dispatchEvent("dragover", directHeaderDrag);
    await expectCount(page.locator(".chat-split-view__drop-indicator"), 1);
    await targetHeader.dispatchEvent("drop", directHeaderDrag);
    await dataTransfer.dispose();

    await expectCount(panes, 3);
    await expect
      .poll(async () =>
        (await page.locator(".chat-pane__session-title").allTextContents()).map((title) =>
          title.trim(),
        ),
      )
      .toContain("Session B");
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:session-b"));
  });

  it.each([
    { name: "current context and latest-run cost", stale: false },
    { name: "approximate stale context without a warning", stale: true },
  ])("shows $name in the composer usage ring", async ({ stale }) => {
    const { page } = await chatFixture(suite, {
      ...(stale
        ? {}
        : {
            historyMessages: [
              { role: "user", content: "Show current usage", timestamp: Date.now() - 1_000 },
              {
                role: "assistant",
                content: "Usage ready.",
                model: "gpt-5.5",
                provider: "openai",
                timestamp: Date.now(),
                cost: {
                  input: 0.003456,
                  output: 0.018,
                  cacheRead: 0.0015,
                  cacheWrite: 0.0005,
                  total: 0.023456,
                },
              },
              {
                role: "assistant",
                content: "Usage ready.",
                model: "gateway-injected",
                provider: "openclaw",
                timestamp: Date.now() + 1,
                usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              },
            ],
          }),
      methodResponses: {
        "sessions.list": {
          count: 1,
          path: "",
          ts: Date.now(),
          defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
          sessions: [
            {
              key: "main",
              kind: "direct",
              contextTokens: 200_000,
              updatedAt: Date.now(),
              ...(stale
                ? { totalTokens: 190_000, totalTokensFresh: false }
                : {
                    estimatedCostUsd: 0.023456,
                    inputTokens: 757_300,
                    outputTokens: 42_300,
                    totalTokens: 46_000,
                    model: "gpt-5.5",
                    modelProvider: "openai",
                  }),
            },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const trigger = page.locator("summary.context-ring");
    await trigger.waitFor({ timeout: 10_000 });
    if (stale) {
      expect((await trigger.textContent())?.trim()).toBe("");
      expect(await trigger.getAttribute("aria-label")).toBe(
        "Session context usage: ~190k of 200k (~95%)",
      );
      expect(
        await trigger.evaluate((element) => element.classList.contains("context-ring--warning")),
      ).toBe(false);
    }
    await trigger.click();
    const popover = page.locator(".context-usage__popover");
    if (stale) {
      await expectTextContains(popover, "~190k / 200k · ~95%");
    } else {
      await expect.poll(() => popover.isVisible()).toBe(true);
      for (const text of ["46k / 200k · 23%", "757.3k", "42.3k", "Cost", "$0.023"]) {
        await expectTextContains(popover, text);
      }
      const costBreakdown = await popover
        .locator(".context-usage__stats > div[title]")
        .getAttribute("title");
      for (const amount of ["$0.0035", "$0.018", "$0.0015", "$0.0005"]) {
        expect(costBreakdown).toContain(amount);
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => popover.isHidden()).toBe(true);
    }
  });

  it("routes page typing to the active composer without stealing text input focus", async () => {
    const { page } = await chatFixture(suite, {
      historyMessages: [timedText("assistant", "Type whenever you are ready.")],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Type whenever you are ready.").click();

    const composer = chatComposer(page);
    await expect
      .poll(() => composer.evaluate((element) => element === document.activeElement))
      .toBe(false);

    await page.keyboard.type("first character preserved");
    expect(await composer.inputValue()).toBe("first character preserved");
    await expect
      .poll(() => composer.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await page.getByRole("button", { name: "Command palette" }).click();
    const paletteInput = page.locator(".cmd-palette__input");
    await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
    await expect
      .poll(() => paletteInput.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.type("session search");

    expect(await paletteInput.inputValue()).toBe("session search");
    expect(await composer.inputValue()).toBe("first character preserved");
  });

  it("keeps chat usable while sessions are still loading", async () => {
    const { page, gateway } = await chatFixture(suite, {
      deferredMethods: ["sessions.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      historyMessages: [timedText("assistant", "History renders before sessions finish.")],
    });

    await page.goto(`${suite.server.baseUrl}chat`);

    await page.getByText("History renders before sessions finish.").waitFor({ timeout: 10_000 });
    const composer = chatComposer(page);
    await composer.waitFor({ state: "visible", timeout: 10_000 });

    // The chat boot hydrates the sidebar session list; that request stays
    // deferred here while the composer must remain fully usable.
    await gateway.waitForRequest("sessions.list", { match: rosterMatch });

    await composer.fill("draft while sessions load");
    expect(await composer.inputValue()).toBe("draft while sessions load");
    await composer.fill("");

    // The background hydrate must not take the shared sessions loading
    // flag, which would disable New conversation for the whole request.
    const newThread = page.getByRole("link", { name: "New conversation" }).first();
    expect(await newThread.isEnabled()).toBe(true);

    await gateway.resolveDeferred("sessions.list");
    await expect.poll(() => newThread.isEnabled()).toBe(true);
  });

  it("keeps every sidebar session stable while selecting sessions and supports sort modes", async () => {
    const { page } = await newChatPage(suite);
    const createdSessionKeys = Array.from(
      { length: 16 },
      (_, index) => `agent:main:session-${String.fromCharCode(97 + index)}`,
    );
    const pinnedSessionKey = "agent:main:session-pinned";
    const createdOrder = [pinnedSessionKey, ...createdSessionKeys];
    // Personal pins lead the list in their Pinned section regardless of sort mode.
    const updatedOrder = [pinnedSessionKey, ...createdSessionKeys.toReversed()];
    const sessions = chatSessionListResponse([
      sessionRow(pinnedSessionKey, "Pinned Session", 50, { createdAt: 2_000 }),
      ...createdSessionKeys.map((key, index) =>
        sessionRow(key, `Session ${key.slice(-1).toUpperCase()}`, (index + 1) * 100, {
          createdAt: 1_000 - index,
        }),
      ),
    ]);
    await page.addInitScript(
      ({ storageKey, entry }) => {
        const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
        localStorage.setItem(storageKey, JSON.stringify({ ...settings, railShortcuts: [entry] }));
      },
      {
        storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        entry: `session:${pinnedSessionKey}`,
      },
    );
    await installMockGateway(page, {
      methodResponses: { "sessions.list": sessions },
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    await page
      .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
      .waitFor({ timeout: 10_000 });
    // Pinned rows sit above, and do not occupy, the fifteen-row Sessions page.
    const pinnedLink = page.locator(
      `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${pinnedSessionKey}"] a.sidebar-recent-session__link`,
    );
    await pinnedLink.waitFor();
    await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder.slice(0, 16));
    const more = page.getByRole("button", { name: "Show more", exact: true });
    await more.click();
    await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);
    expect(await more.count()).toBe(0);

    await page
      .locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
      )
      .click();
    await page
      .locator(".sidebar-recent-session--active")
      .getByText("Session B")
      .waitFor({ timeout: 10_000 });
    await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

    const activeWeight = await page
      .locator('.sidebar-recent-session[data-session-key="agent:main:session-b"]')
      .locator(".sidebar-recent-session__name")
      .evaluate((label) => getComputedStyle(label).fontWeight);
    const inactiveWeight = await page
      .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
      .locator(".sidebar-recent-session__name")
      .evaluate((label) => getComputedStyle(label).fontWeight);
    expect(activeWeight).toBe(inactiveWeight);
    expect(inactiveWeight).toBe("500");

    const filterAndSort = page.getByRole("button", { name: /^Filter & sort · /, exact: true });
    await filterAndSort.click();
    await chooseSidebarMenuOption(page, "Sort by", "Last updated");
    await closeSidebarMenu(page);
    await expect.poll(() => sidebarSessionOrder(page)).toEqual(updatedOrder);
    expect(await pinnedLink.isVisible()).toBe(true);

    await filterAndSort.click();
    await chooseSidebarMenuOption(page, "Sort by", "Created");
    await closeSidebarMenu(page);
    await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

    await filterAndSort.click();
    await page.getByRole("main").click();
    await expectCount(page.locator(".sidebar-session-sort-menu"), 0);
  });

  it("keeps derived sidebar titles and accessible state after session patch refreshes", async () => {
    const { page } = await newChatPage(suite);
    const initialKey = "agent:main:session-a";
    const key = "agent:main:session-b";
    const readableTitle = "Readable planning title";
    const baseTime = Date.now();
    const sessions = [
      sessionRow(initialKey, initialKey, baseTime, { displayName: initialKey }),
      sessionRow(key, key, baseTime - 60_000, { displayName: key }),
    ];
    const sessionsWithoutDerivedTitle = chatSessionListResponse(sessions);
    const sessionsWithDerivedTitle = chatSessionListResponse(
      sessions.map((session, index) =>
        Object.assign({}, session, {
          derivedTitle: index === 0 ? "Initial readable title" : readableTitle,
        }),
      ),
    );
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      sessions,
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { includeDerivedTitles: true }, response: sessionsWithDerivedTitle },
            { match: {}, response: sessionsWithoutDerivedTitle },
          ],
        },
      },
      sessionKey: initialKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, initialKey));
    const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
    await row.locator("a.sidebar-recent-session__link").click();
    await expect
      .poll(async () => {
        const requests = await gateway.getRequests("sessions.list", rosterMatch);
        return requests.map((request) => request.params);
      })
      .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
    const label = row.locator(".sidebar-recent-session__name");
    const link = row.locator("a.sidebar-recent-session__link");
    const tree = row.locator("..");
    const list = tree.locator('xpath=ancestor::*[@role="list"][1]');
    await expectText(label, readableTitle);
    expect(await list.getAttribute("role")).toBe("list");
    expect(await tree.getAttribute("role")).toBe("listitem");
    expect(await row.getAttribute("role")).toBeNull();
    expect(await row.getAttribute("aria-label")).toBeNull();
    expect(await link.getAttribute("aria-label")).toBeNull();
    expect(await link.getAttribute("aria-current")).toBe("page");
    expect(await link.getAttribute("aria-describedby")).toBeNull();
    expect(await link.ariaSnapshot()).toContain(`link "${readableTitle}"`);
    await captureSessionAccessibilityProof(suite, page, "after-derived-title");

    const listCountBeforePatch = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    // Unread remains shared session metadata; personal pinning no longer patches or refreshes it.
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();

    const patchRequest = await gateway.waitForRequest("sessions.patch", {
      match: { key, unread: true },
    });
    expect(requireRecord(patchRequest.params)).toMatchObject({ key, unread: true });
    await expect
      .poll(async () => {
        const requests = await gateway.getRequests("sessions.list", rosterMatch);
        return requests.slice(listCountBeforePatch).map((request) => request.params);
      })
      .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
    await expectText(label, readableTitle);
    expect(await link.getAttribute("aria-current")).toBe("page");
    // The retained title can match before the refresh renders Unread.
    await expect.poll(() => link.ariaSnapshot()).toContain(`link "Unread ${readableTitle}"`);
    expect(await link.getByRole("img", { name: "Unread", exact: true }).count()).toBe(1);
    await captureSessionAccessibilityProof(suite, page, "after-patch-refresh");
  });
});
