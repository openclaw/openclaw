import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatLayoutMenu, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createBoardE2eSuite } from "./board-browser.test-support.ts";
import {
  focusChatSidePanel,
  openChatSidePanelType,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";

const sessionKey = "agent:main:board-split-transcript";
const suite = createBoardE2eSuite("Board split transcript restore", { sandbox: false });
const viewport = { width: 1400, height: 900 };

async function newPage(size = viewport) {
  return { page: await suite.newPage({ viewport: size }) };
}

async function retainDashboard(page: Page) {
  const view = page.locator("openclaw-board-view");
  const initial = await view.elementHandle();
  expect(initial).not.toBeNull();
  return {
    connected: () => initial!.evaluate((element) => element.isConnected),
    same: () => view.evaluate((element, previous) => element === previous, initial),
  };
}

function installBoard(
  page: Page,
  methods: string[] = [],
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    sessionKey,
    featureMethods: ["board.get", "chat.metadata", "chat.startup", ...methods],
    ...options,
    methodResponses: { "board.get": boardSnapshot(), ...options.methodResponses },
  });
}

type TranscriptGeometry = {
  width: number;
  rowGap: number;
  assistantUserGap: number;
};

function boardSnapshot(revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [],
  };
}

async function visibleTranscriptState(page: Page) {
  return await page.evaluate(() => {
    const inner = [...document.querySelectorAll<HTMLElement>(".chat-thread-inner--virtual")].find(
      (candidate) => {
        const cachePane = candidate.closest(".chat-pane-cache__pane");
        return !cachePane || cachePane.classList.contains("chat-pane-cache__pane--visible");
      },
    );
    const scroller = inner?.parentElement;
    if (!inner || !scroller) {
      return { present: false, intersectingRows: 0 };
    }
    const rect = scroller.getBoundingClientRect();
    const intersectingRows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")].filter(
      (row) => {
        const rowRect = row.getBoundingClientRect();
        return rowRect.bottom > rect.top && rowRect.top < rect.bottom;
      },
    ).length;
    return { present: true, intersectingRows };
  });
}

async function firstSidebarResizeFrame(page: Page, resize: () => Promise<void>) {
  const firstFrame = page.evaluate(
    () =>
      new Promise<TranscriptGeometry>((resolve, reject) => {
        const panel = document.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
        const region = panel?.closest(".sidebar-region");
        const transcript = document.querySelector<HTMLElement>(".sidebar-region__primary");
        if (!panel || !region || !transcript) {
          throw new Error("Dashboard side panel or primary chat region is missing");
        }
        const observer = new MutationObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => {
            const [assistantRow, userRow] =
              transcript.querySelectorAll<HTMLElement>(".chat-virtual-row");
            const assistant = assistantRow?.querySelector<HTMLElement>(
              ".chat-group.assistant .chat-text",
            );
            const user = userRow?.querySelector<HTMLElement>(".chat-group.user .chat-bubble");
            if (!assistantRow || !userRow || !assistant || !user) {
              reject(new Error("Adjacent assistant and user transcript rows are missing"));
              return;
            }
            resolve({
              width: panel.getBoundingClientRect().width,
              rowGap:
                userRow.getBoundingClientRect().top - assistantRow.getBoundingClientRect().bottom,
              assistantUserGap:
                user.getBoundingClientRect().top - assistant.getBoundingClientRect().bottom,
            });
          });
        });
        observer.observe(region, { attributes: true, attributeFilter: ["style"] });
      }),
  );
  await resize();
  return await firstFrame;
}

async function expectSidePanelTabs(page: Page, expected: string[], visible = true) {
  const labels = page.locator('[data-region-header="side"] .tabstrip-tab__label');
  await expect
    .poll(() => labels.allTextContents().then((values) => values.toSorted()))
    .toEqual(expected.toSorted());
  await labels.first().waitFor({ state: visible ? "visible" : "hidden" });
}

async function expectMinimizedDashboard(page: Page) {
  await page.locator('[data-region-header="side"]').waitFor({ state: "hidden" });
  await expect
    .poll(() =>
      page.locator(".board-session-surface").evaluate((panel) => {
        const { width, height } = panel.getBoundingClientRect();
        const primary = document.querySelector(".sidebar-region__primary")!;
        return {
          hidden: panel.hasAttribute("hidden"),
          inert: panel.hasAttribute("inert"),
          width,
          height,
          fillsPrimary:
            Math.abs(
              primary.getBoundingClientRect().width -
                primary.parentElement!.getBoundingClientRect().width,
            ) < 1,
        };
      }),
    )
    .toEqual({ hidden: true, inert: true, width: 0, height: 0, fillsPrimary: true });
  expect(await page.getByRole("separator", { name: "Resize side panel" }).count()).toBe(0);
}

suite.define(() => {
  it("repaints the transcript after expanded -> split", async () => {
    const { page } = await newPage();
    const now = Date.now();
    await installBoard(page, ["chat.history"], {
      historyMessages: Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message number ${index}: the quick brown fox jumps over the lazy dog to give this bubble a realistic height.`,
        timestamp: now - (40 - index) * 60_000,
      })),
    });

    await suite.openDashboard(page, sessionKey, false);
    await page.locator(".board-session-surface").waitFor();
    await page.getByText("Message number 39:").first().waitFor({ timeout: 15_000 });

    await focusChatSidePanel(page);
    await expect
      .poll(async () => (await visibleTranscriptState(page)).intersectingRows, { timeout: 5_000 })
      .toBe(0);

    await selectChatLayoutAction(page, "Restore split");

    // Collapse itself must repaint, without an unrelated render.
    await expect
      .poll(async () => await visibleTranscriptState(page), { timeout: 2_000 })
      .toMatchObject({ present: true, intersectingRows: expect.any(Number) });
    await expect
      .poll(async () => (await visibleTranscriptState(page)).intersectingRows, { timeout: 2_000 })
      .toBeGreaterThan(0);
    await page
      .getByText("Message number 39:")
      .first()
      .waitFor({ state: "visible", timeout: 2_000 });
  }, 120_000);

  it("keeps adjacent chat rows separated throughout a real dashboard-panel resize", async () => {
    const { page } = await newPage({ width: 1720, height: 1250 });
    const now = Date.now();
    await installBoard(page, ["chat.history"], {
      historyMessages: [
        {
          role: "assistant",
          content:
            "Created **Project Board** with a full-screen four-column dashboard:\n\n- Working\n- Idle\n- Review\n- Complete\n\nThe board can refresh active work and show a concise operator summary.\n\nSource: [project-board.html](project-board.html)\n\n" +
            "Keep the work board visible while tracking active sessions, reviews, approvals, and completed tasks. ".repeat(
              8,
            ),
          timestamp: now - 1,
        },
        {
          role: "user",
          content: "Please use the existing work board feature.",
          timestamp: now,
        },
      ],
    });

    await suite.openDashboard(page, sessionKey, false);
    const sidePanel = page.locator('[data-panel-slot="dashboard"]');
    await page.getByText("Source: project-board.html", { exact: false }).waitFor();
    await page.getByText("Please use the existing work board feature.").waitFor();
    const initialWidth = await sidePanel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );

    const divider = page.getByRole("separator", { name: "Resize side panel" });
    const dividerBounds = await divider.boundingBox();
    expect(dividerBounds).not.toBeNull();
    const startX = dividerBounds!.x + dividerBounds!.width / 2;
    const pointerY = dividerBounds!.y + Math.min(80, dividerBounds!.height / 2);
    await page.mouse.move(startX, pointerY);
    await page.mouse.down();
    const frame = await firstSidebarResizeFrame(page, () => page.mouse.move(startX + 64, pointerY));
    await page.mouse.up();

    expect(frame.width).toBeLessThan(initialWidth);
    expect(frame.rowGap).toBeGreaterThanOrEqual(-0.01);
    expect(frame.assistantUserGap).toBeGreaterThanOrEqual(-0.01);
  }, 120_000);

  it("transitions between expanded and split dashboard panel states", async () => {
    const { page } = await newPage();
    const gateway = await installBoard(page, ["browser.request", "terminal.open"], {
      terminalEnabled: true,
      methodResponses: {
        "browser.request": {
          cases: [
            { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
          ],
        },
      },
    });
    await suite.openDashboard(page, sessionKey, false);
    await page.locator('[data-region-header="side"]').waitFor();
    await openChatSidePanelType(page, "Browser");
    await openChatSidePanelType(page, "Terminal");

    const sidePanel = page.locator(".side-panel");
    const chat = page.locator(".chat-thread");
    const expectedTabLabels = ["Dashboard", "Browser", "zsh"];
    await expectSidePanelTabs(page, expectedTabLabels);
    const terminalPanel = page.locator('[data-panel-slot="terminal"]');
    const widthBeforeExpand = await terminalPanel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );

    await focusChatSidePanel(page);
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
    await expect.poll(() => chat.isHidden()).toBe(true);
    await expect
      .poll(() => terminalPanel.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(widthBeforeExpand);
    await expectSidePanelTabs(page, ["Dashboard", "Browser", "OpenClaw"], false);

    await selectChatLayoutAction(page, "Restore split");
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
    await expect.poll(() => chat.isVisible()).toBe(true);
    await restoreChatAsMain(page);
    await expectSidePanelTabs(page, expectedTabLabels);
    expect(await sidePanel.locator('[data-panel-slot="dashboard"]').count()).toBe(1);
    const dashboard = await retainDashboard(page);

    await selectChatLayoutAction(page, "Minimize side panel");
    await expectMinimizedDashboard(page);
    expect(await dashboard.connected()).toBe(true);
    await expect.poll(() => chat.isVisible()).toBe(true);

    await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
    await sidePanel.locator('[data-region-header="side"]').waitFor();
    await expectSidePanelTabs(page, expectedTabLabels);
    expect(await dashboard.same()).toBe(true);
    await expect.poll(() => chat.isVisible()).toBe(true);
    expect(await gateway.getRequests("board.update")).toHaveLength(0);
  }, 120_000);

  it("activates Side chat from a split dashboard panel", async () => {
    const { page } = await newPage();
    await installBoard(page, ["board.update", "chat.history", "sessions.companion.ask"], {
      methodResponses: {
        "board.update": boardSnapshot(2),
      },
      historyMessages: [
        { role: "user", content: "Keep the dashboard visible while I open a side chat." },
        { role: "assistant", content: "The board chat is currently active." },
      ],
    });

    await suite.openDashboard(page, sessionKey, false);
    const sidePanel = page.locator(".side-panel");
    await sidePanel.locator('[data-region-header="side"]').waitFor();
    await openChatSidePanelType(page, "Side chat");
    await expectSidePanelTabs(page, ["Dashboard", "Side chat"]);

    await sidePanel.locator(".tabstrip-tab").filter({ hasText: "Side chat" }).click();
    await sidePanel.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();
    await expect
      .poll(() =>
        sidePanel
          .locator('[data-panel-slot="dashboard"]')
          .evaluate((panel) => panel.hasAttribute("hidden")),
      )
      .toBe(true);
  }, 120_000);

  it("does not offer Discussion when the gateway has no discussion provider", async () => {
    const { page } = await newPage();
    const gateway = await installBoard(page, ["session.discussion.info"], {
      methodResponses: {
        "session.discussion.info": { state: "none" },
      },
    });

    await suite.openDashboard(page, sessionKey, false);
    const sidePanel = page.locator(".side-panel");
    await sidePanel.locator('[data-region-header="side"]').waitFor();
    await expect
      .poll(() =>
        gateway.getRequests("session.discussion.info").then((requests) => requests.length),
      )
      .toBe(1);
    const layoutMenu = await openChatLayoutMenu(page);
    await expect
      .poll(() =>
        layoutMenu.locator('[role^="menuitem"]').filter({ hasText: "Discussion" }).count(),
      )
      .toBe(0);
  }, 120_000);

  it("retains a sole Dashboard when minimized and reopened from Layout", async () => {
    const { page } = await newPage();
    const gateway = await installBoard(page);
    await suite.openDashboard(page, sessionKey, false);

    const sidePanel = page.locator(".side-panel");
    await sidePanel.locator('[data-region-header="side"]').waitFor();
    await expectSidePanelTabs(page, ["Dashboard"]);
    const dashboard = await retainDashboard(page);
    for (let cycle = 0; cycle < 2; cycle++) {
      await selectChatLayoutAction(page, "Minimize side panel");
      await expectMinimizedDashboard(page);
      expect(await dashboard.connected()).toBe(true);
      expect(await gateway.getRequests("board.update")).toHaveLength(0);
      await selectChatLayoutAction(page, "Side panel");
      await sidePanel.locator('[data-region-header="side"]').waitFor();
      await expectSidePanelTabs(page, ["Dashboard"]);
      expect(await dashboard.same()).toBe(true);
      expect(await gateway.getRequests("board.update")).toHaveLength(0);
    }
  }, 120_000);
});
