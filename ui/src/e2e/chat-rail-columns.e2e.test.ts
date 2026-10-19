import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  activateChatHeaderPanelAction,
  dockChatSidePanel,
  openChatSidePanelType as openFromPlus,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat tabbed side panel",
  startServerBeforeBrowser: true,
});

function withPage(run: (page: Page) => Promise<void>, options: BrowserContextOptions = {}) {
  return suite.withPage(
    {
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1600 },
      ...options,
    },
    ({ page }) => run(page),
  );
}

const sessionKey = "agent:main:rail-tabs";
const workspaceRoot = "/workspace/openclaw";
const fileRows = [
  ["modified", "chat-pane-render.ts", "ui/src/pages/chat/chat-pane-render.ts"],
  ["read", "sidebar.css", "ui/src/styles/chat/sidebar.css"],
] as const;
const proofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
const videoDirParent = process.env.OPENCLAW_UI_RAIL_VIDEO_DIR?.trim();
let proofDir: string | undefined;
let videoDir: string | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("chat-rail-columns", proofDirParent)
    : undefined;
  videoDir = videoDirParent
    ? proofDir && proofDirParent && path.resolve(videoDirParent) === path.resolve(proofDirParent)
      ? proofDir
      : createControlUiE2eArtifactDir("chat-rail-columns", videoDirParent)
    : undefined;
});

const historyMessages = Array.from({ length: 10 }, (_, index) => ({
  id: `rail-tabs-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: [
    {
      type: "text",
      text: `Checkpoint ${index + 1}: keep the conversation visible while working with session tools.`,
    },
  ],
  timestamp: Date.now() - (10 - index) * 60_000,
}));

function scenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "desktop.observe",
      "environments.list",
      "environments.status",
      "sessions.diff",
      "terminal.open",
    ],
    historyMessages,
    methodResponses: {
      "browser.request": {
        cases: [{ match: { method: "GET", path: "/tabs" }, response: { running: true, tabs: [] } }],
      },
      "desktop.observe": {
        transport: "rfb",
        wsPath: "/desktop/observe?token=rail-tabs",
        expiresAtMs: 60_000,
        control: false,
        auth: "vnc-password",
      },
      "environments.status": { id: "gateway", type: "local", status: "available", desktop: true },
      "sessions.diff": {
        sessionKey,
        files: [
          {
            path: "ui/src/pages/chat/chat-pane-render.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1,0 +1 @@\n+single side panel\n",
          },
        ],
        additions: 1,
        deletions: 0,
      },
      "sessions.companion.ask": {
        answer: "The mobile side chat stayed inside its panel.",
        ts: Date.UTC(2026, 7, 16, 12, 0),
      },
      "sessions.companion.state": { exchanges: [] },
      "sessions.files.list": {
        files: fileRows.map(([kind, name, filePath]) => ({
          kind,
          name,
          path: `${workspaceRoot}/${filePath}`,
          missing: false,
        })),
        root: workspaceRoot,
        sessionKey,
      },
      "terminal.list": { sessions: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: workspaceRoot,
        sessionId: "rail-tabs-terminal",
        shell: "/bin/zsh",
      },
    },
    sessionKey,
    terminalEnabled: true,
    workspace: workspaceRoot,
    workspaceGit: true,
  };
}

async function seedSettings(page: Page, themeMode: "light" | "dark", dock?: "bottom" | "right") {
  const columns = { columns: [], open: false, expanded: false, ...(dock ? { dock } : {}) };
  const settings = JSON.stringify({
    theme: "claw",
    themeMode,
    sidebarSessionLayouts: { [sessionKey]: columns },
  });
  await page.addInitScript(
    ({ key, settings: storedSettings, dock: storedDock }) => {
      if (!storedDock && localStorage.getItem(key) !== null) {
        return;
      }
      localStorage.setItem(key, storedSettings);
      if (storedDock) {
        localStorage.setItem(
          "openclaw.browser.panel.v1",
          JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
        );
      }
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), settings, dock },
  );
}

function sidePanel(page: Page): Locator {
  return page.locator(".sidebar-region__right-runtime .side-panel");
}

function sidePanelBody(page: Page): Locator {
  return page.locator('.sidebar-region [data-region="side"]:not([hidden])');
}

// Scope tab queries to the side header so a panel promoted to main cannot add
// its own strip to the side-panel assertions.
const sidePanelTabLabelSelector = '[data-region-header="side"] .tabstrip-tab__label';

function sideHeader(page: Page) {
  return sidePanel(page).locator('[data-region-header="side"]');
}

function activeTabLabel(page: Page) {
  return sideHeader(page).locator(".tabstrip-tab[active] .tabstrip-tab__label");
}

function panelSize(page: Page, dimension: "width" | "height") {
  return sidePanelBody(page).evaluate(
    (element, key) => element.getBoundingClientRect()[key],
    dimension,
  );
}

function waitForSlot(page: Page, slot: string) {
  return sidePanel(page).locator(`[data-panel-slot="${slot}"]:not([hidden])`).waitFor();
}

function dockLayout(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content--chat")!;
    const panel = document.querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const region = document.querySelector<HTMLElement>(".sidebar-region")!;
    return {
      marginRight: getComputedStyle(content).marginRight,
      bottomDock: region.classList.contains("sidebar-region--bottom"),
      spansRegion:
        Math.abs(panel.getBoundingClientRect().width - region.getBoundingClientRect().width) < 1,
    };
  });
}

async function startChat(page: Page, theme: "light" | "dark", dock?: "right" | "bottom") {
  await seedSettings(page, theme, dock);
  const gateway = await installMockGateway(page, scenario());
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.locator(".chat-group").first().waitFor();
  return gateway;
}

async function reloadChat(page: Page) {
  await page.reload();
  await page.locator(".chat-group").first().waitFor();
}

function computedStyle(locator: Locator, property: "opacity" | "display") {
  return locator.evaluate((element, key) => getComputedStyle(element)[key], property);
}

function tabGeometry(tab: Locator) {
  return tab.evaluate((element) => ({
    closeWidth: (element.nextElementSibling as HTMLElement).offsetWidth,
    tabWidth: (element as HTMLElement).offsetWidth,
  }));
}

function tabCloseHasTransparentBackground(tab: Locator) {
  return tab.evaluate((element) => {
    const close = element.nextElementSibling;
    return close ? getComputedStyle(close).backgroundColor === "rgba(0, 0, 0, 0)" : false;
  });
}

async function waitForPanelGeometry(page: Page) {
  await page.locator(".sidebar-region").evaluate(async (element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function dragDivider(page: Page, divider: Locator, axis: "x" | "y", delta: number) {
  await waitForPanelGeometry(page);
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + (axis === "x" ? 1 : box!.width / 2);
  const y = box!.y + (axis === "y" ? 1 : box!.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(axis === "x" ? box!.x + delta : x, axis === "y" ? box!.y + delta : y);
  await page.mouse.up();
}

async function tabLabels(page: Page): Promise<string[]> {
  return sidePanel(page)
    .locator(sidePanelTabLabelSelector)
    .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
}

async function narrowestRailTabLabel(page: Page): Promise<number> {
  return sidePanel(page)
    .locator(sidePanelTabLabelSelector)
    .evaluateAll((labels) =>
      Math.min(...labels.map((label) => (label as HTMLElement).getBoundingClientRect().width)),
    );
}

async function waitForPanelGeometry(page: Page): Promise<void> {
  await page.locator(".sidebar-region").evaluate(async (element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function expectExpandedSidePanelFillsRegion(
  page: Page,
  placement: "main" | "side" = "main",
): Promise<void> {
  await waitForPanelGeometry(page);
  const geometry = await page
    .locator(`.sidebar-region [data-region="${placement}"]:not([hidden])`)
    .evaluate((element, slot) => {
      const panel = element.getBoundingClientRect();
      const shell = element.closest(".sidebar-region");
      const region = shell?.getBoundingClientRect();
      const header = shell?.querySelector(".chat-pane__header")?.getBoundingClientRect();
      const tabs =
        slot === "side"
          ? shell?.querySelector('[data-region-header="side"]')?.getBoundingClientRect()
          : undefined;
      if (!region || !header) {
        throw new Error("Focused panel requires its task toolbar and sidebar region");
      }
      if (slot === "side" && !tabs) {
        throw new Error("An expanded side panel requires its retained tab strip");
      }
      return {
        bottom: Math.abs(panel.bottom - region.bottom),
        left: Math.abs(panel.left - region.left),
        right: Math.abs(panel.right - region.right),
        top: Math.abs((tabs ?? header).top - region.top),
        headerGap: Math.abs(panel.top - (tabs?.bottom ?? header.bottom)),
      };
    }, placement);
  for (const delta of Object.values(geometry)) {
    expect(delta).toBeLessThanOrEqual(1);
  }
}

async function captureRichPanel(page: Page, name: string, directory = proofDir) {
  if (!directory) {
    return;
  }
  const clip = await page.evaluate(() => {
    const elements = [".chat-pane__header", ".agent-chat__scroll", ".sidebar-region"]
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) {
      throw new Error("No chat panel geometry found for evidence clip");
    }
    const rects = elements.map((element) => element.getBoundingClientRect());
    const x = Math.max(0, Math.min(...rects.map((rect) => rect.left)));
    const y = Math.max(0, Math.min(...rects.map((rect) => rect.top)));
    const right = Math.min(innerWidth, Math.max(...rects.map((rect) => rect.right)));
    const bottom = Math.min(innerHeight, Math.max(...rects.map((rect) => rect.bottom)));
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: path.join(directory, `${name}.png`), clip });
}

async function exerciseTabbedPanel(page: Page, themeMode: "light" | "dark") {
  const gateway = await startChat(page, themeMode);
  const rail = sidePanel(page);
  const header = sideHeader(page);

  await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
  await rail.locator(".side-panel-launcher").waitFor();
  expect(await rail.locator(".tabstrip-tab").count()).toBe(0);
  await captureRichPanel(page, `rails-tabs-empty-${themeMode}`);

  await rail
    .locator(".side-panel-launcher")
    .getByRole("button")
    .filter({ has: page.locator(".side-panel-type-option__label", { hasText: /^Files$/ }) })
    .click();
  await waitForSlot(page, "workspace");
  await expect.poll(() => rail.textContent()).toContain("chat-pane-render.ts");
  await activateChatHeaderPanelAction(page, "Show session changes");
  await gateway.waitForRequest("sessions.diff");
  await waitForSlot(page, "detail");
  const changedFile = rail.getByRole("button", {
    name: "ui/src/pages/chat/chat-pane-render.ts — Modified",
    exact: true,
  });
  await changedFile.click();
  await expect.poll(() => changedFile.getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => rail.textContent()).toContain("single side panel");
  await captureRichPanel(page, `rails-tabs-review-${themeMode}`);

  await openFromPlus(page, "Terminal");
  const terminalOpen = await gateway.waitForRequest("terminal.open");
  expect(terminalOpen.params).toMatchObject({ agentId: "main", sessionKey });
  await waitForSlot(page, "terminal");
  await openFromPlus(page, "Browser");
  await waitForSlot(page, "browser");
  await captureRichPanel(page, `rails-tabs-browser-${themeMode}`);
  await openFromPlus(page, "Side chat");
  await waitForSlot(page, "companion");
  await openFromPlus(page, "Desktop");
  await waitForSlot(page, "desktop");
  const desktopObserve = await gateway.waitForRequest("desktop.observe");
  expect(desktopObserve.params).toEqual({ source: { kind: "host" }, control: false });
  await rail.getByLabel("VNC password", { exact: true }).waitFor();
  await captureRichPanel(page, `rails-tabs-desktop-${themeMode}`);
  await expect
    .poll(() => tabLabels(page))
    .toEqual(["Files", "Review", "zsh", "Browser", "Side chat", "Desktop"]);
  await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);
  await expect
    .poll(() =>
      header.locator(".tabstrip-tab__icon").evaluateAll((icons) => {
        const center = (rect?: DOMRect) => (rect?.y ?? 0) + (rect?.height ?? 0) / 2;
        const firstCenter = center(icons[0]?.getBoundingClientRect());
        return icons.map((icon) => {
          const box = icon.getBoundingClientRect();
          const glyph = icon.querySelector("svg")?.getBoundingClientRect();
          const base = icon.closest(".tabstrip-tab")?.getBoundingClientRect();
          return [
            box.width,
            box.height,
            glyph?.width,
            glyph?.height,
            Math.abs(center(box) - center(base)),
            center(box) - firstCenter,
          ];
        });
      }),
    )
    .toEqual(Array.from({ length: 6 }, () => [16, 16, 15, 15, 0, 0]));
  const filesTab = rail.locator(".tabstrip-tab").filter({ hasText: "Files" });
  const filesClose = rail.getByRole("button", { name: "Close Files", exact: true });
  const desktopClose = rail.getByRole("button", { name: "Close Desktop", exact: true });
  await expect.poll(() => computedStyle(filesClose, "opacity")).toBe("0");
  await expect.poll(() => computedStyle(desktopClose, "opacity")).toBe("1");
  const filesGeometry = await tabGeometry(filesTab);
  await filesTab.hover();
  await expect.poll(() => computedStyle(filesClose, "opacity")).toBe("1");
  await expect.poll(() => tabCloseHasTransparentBackground(filesTab)).toBe(true);
  await filesClose.hover();
  await expect.poll(() => tabCloseHasTransparentBackground(filesTab)).toBe(true);
  expect(await tabGeometry(filesTab)).toEqual(filesGeometry);
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    const directory = proofDir ?? createControlUiE2eArtifactDir(`chat-rail-hover-${themeMode}`);
    await captureRichPanel(page, `rails-tab-close-hover-${themeMode}`, directory);
  }
  const railLabels = rail.locator(sidePanelTabLabelSelector);
  let overflowingLabelIndex = -1;
  await expect
    .poll(async () => {
      overflowingLabelIndex = await railLabels.evaluateAll((labels) =>
        labels.findIndex((label) => label.hasAttribute("data-tooltip-overflow")),
      );
      return overflowingLabelIndex;
    })
    .toBeGreaterThanOrEqual(0);
  const overflowingLabel = railLabels.nth(overflowingLabelIndex);
  const fullLabel = (await overflowingLabel.textContent())?.trim();
  const tooltipTrigger = overflowingLabel.locator("..");
  const labelTooltip = tooltipTrigger.locator("..");
  expect(await labelTooltip.evaluate((element) => element.localName)).toBe("openclaw-tooltip");
  expect(
    await overflowingLabel.locator("xpath=ancestor::button[@role='tab']").getAttribute("title"),
  ).toBeNull();
  await tooltipTrigger.hover();
  await expect
    .poll(() =>
      labelTooltip
        .locator(".tooltip-surface[popover]")
        .evaluate((tooltip) => tooltip.matches(":popover-open")),
    )
    .toBe(true);
  expect(await labelTooltip.locator(".tooltip-content").textContent()).toContain(fullLabel);
  await expect
    .poll(() =>
      rail.locator('[data-region-header="side"] .tabstrip').evaluate((group) => {
        const tabsRect = group.getBoundingClientRect();
        const rightmostItem = Math.max(
          ...[
            ...group.querySelectorAll<HTMLElement>(
              ".tabstrip-tab, .tabstrip-tab__close, .tabstrip-separator",
            ),
          ].map((item) => Math.min(item.getBoundingClientRect().right, tabsRect.right)),
        );
        const clipped = [...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label")].some(
          (label) => label.hasAttribute("data-tooltip-overflow"),
        );
        return { clipped, unused: Math.max(0, tabsRect.right - rightmostItem) };
      }),
    )
    .toEqual({ clipped: true, unused: 0 });

  await rail.locator(".tabstrip-tab").filter({ hasText: "Files" }).click();
  await captureRichPanel(page, `rails-tabs-rich-${themeMode}`);

  const panelWidth = await panelSize(page, "width");
  const divider = page.locator(".sidebar-column__divider");
  await dragDivider(page, divider, "x", -90);
  await expect.poll(() => panelSize(page, "width")).toBeGreaterThan(panelWidth + 70);
  const resizedWidth = await panelSize(page, "width");

  await dockChatSidePanel(page, "bottom");
  await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
  await expect.poll(async () => (await dockLayout(page)).spansRegion).toBe(true);
  await expect
    .poll(() => divider.evaluate((element) => (element as { orientation?: string }).orientation))
    .toBe("horizontal");
  await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);
  const bottomHeight = await panelSize(page, "height");
  await dragDivider(page, divider, "y", -70);
  await expect.poll(() => panelSize(page, "height")).toBeGreaterThan(bottomHeight + 50);
  const resizedHeight = await panelSize(page, "height");
  await page.mouse.move(80, 80);
  await page.mouse.click(300, 100);
  // Blur the dragged divider before evidence capture.
  await divider.evaluate((element) => element.blur());
  await captureRichPanel(page, `rails-tabs-bottom-${themeMode}`);

  await selectChatLayoutAction(page, "Minimize side panel");
  await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
  await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
  await expect.poll(() => panelSize(page, "height")).toBeCloseTo(resizedHeight, 0);

  await reloadChat(page);
  await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
  await expect.poll(() => panelSize(page, "height")).toBeCloseTo(resizedHeight, 0);

  await dockChatSidePanel(page, "right");
  await expect
    .poll(() =>
      page
        .locator(".sidebar-region")
        .evaluate((element) => element.classList.contains("sidebar-region--bottom")),
    )
    .toBe(false);
  await expect
    .poll(() => divider.evaluate((element) => (element as { orientation?: string }).orientation))
    .toBe("vertical");
  await expect.poll(() => panelSize(page, "width")).toBeCloseTo(resizedWidth, 0);

  const primary = page.locator(".sidebar-region__primary");
  const retainedPrimary = await primary.elementHandle();
  await selectChatLayoutAction(page, "Expand Side panel");
  await expect.poll(() => primary.isVisible()).toBe(false);
  expect(await primary.getAttribute("hidden")).not.toBeNull();
  expect(await primary.getAttribute("inert")).not.toBeNull();
  expect(await retainedPrimary!.evaluate((element) => element.isConnected)).toBe(true);
  await expectExpandedSidePanelFillsRegion(page, "side");
  await captureRichPanel(page, `rails-tabs-expanded-${themeMode}`);
  await selectChatLayoutAction(page, "Restore split");
  await waitForPanelGeometry(page);
  await expect.poll(() => primary.isVisible()).toBe(true);
  expect(await panelSize(page, "width")).toBeCloseTo(resizedWidth, 0);
  expect(await primary.getAttribute("inert")).toBeNull();
  expect(await primary.evaluate((element, original) => element === original, retainedPrimary)).toBe(
    true,
  );

  await selectChatLayoutAction(page, "Minimize side panel");
  await expect.poll(() => header.isVisible()).toBe(false);
  await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
  await expect.poll(() => panelSize(page, "width")).toBeCloseTo(resizedWidth, 0);

  await reloadChat(page);
  await header.waitFor();
  await expect
    .poll(() => tabLabels(page))
    .toEqual(["Files", "Review", "zsh", "Browser", "Side chat", "Desktop"]);
  await expect.poll(() => panelSize(page, "width")).toBeCloseTo(resizedWidth, 0);
  expect(await activeTabLabel(page).textContent()).toContain("Files");

  await page.keyboard.press("Meta+Shift+B");
  await expect.poll(async () => (await tabLabels(page)).includes("Files")).toBe(false);
  await page.keyboard.press("Meta+Shift+B");
  await expect.poll(async () => (await tabLabels(page)).at(-1)).toBe("Files");
  await page.keyboard.press("Control+Backquote");
  await expect.poll(() => activeTabLabel(page).textContent()).toBe("zsh");
  await page.keyboard.press("Control+Backquote");
  await expect.poll(async () => (await tabLabels(page)).includes("zsh")).toBe(false);

  for (const label of ["Review", "Browser", "Side chat", "Desktop", "Files"]) {
    await header.getByRole("button", { name: `Close ${label}`, exact: true }).click();
  }
  await expect.poll(() => header.isVisible()).toBe(false);
  await reloadChat(page);
  await expect.poll(() => header.isVisible()).toBe(false);
  await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
  await rail.locator(".side-panel-launcher").waitFor();
  expect(await rail.locator(".tabstrip-tab").count()).toBe(0);
  // Shrink: the Browser default can leave this saved column near its maximum.
  await dragDivider(page, divider, "x", 70);
  await expect.poll(() => panelSize(page, "width")).toBeLessThan(resizedWidth - 50);
  const emptyResizedWidth = await panelSize(page, "width");
  await divider.evaluate((element) => element.blur());
  await captureRichPanel(page, `rails-tabs-empty-resized-${themeMode}`);

  await reloadChat(page);
  await rail.locator(".side-panel-launcher").waitFor();
  expect(await divider.boundingBox()).not.toBeNull();
  await expect.poll(() => panelSize(page, "width")).toBeCloseTo(emptyResizedWidth, 0);
  await rail
    .locator(".side-panel-launcher")
    .getByRole("button")
    .filter({ has: page.locator(".side-panel-type-option__label", { hasText: /^Terminal$/ }) })
    .click();
  await expect.poll(() => panelSize(page, "width")).toBeCloseTo(emptyResizedWidth, 0);
  const restoredTerminal = rail.locator('.tabstrip-tab[data-tab-value^="hosted:terminal:"]');
  await restoredTerminal.click();
  const terminalLabel = restoredTerminal.locator(".tabstrip-tab__label");
  await expect.poll(() => terminalLabel.textContent()).toBe("shell 1");
  expect(await restoredTerminal.getAttribute("class")).toContain("is-exited");
  expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
  await expect
    .poll(() =>
      terminalLabel.evaluate((label) => {
        const element = label as HTMLElement;
        return {
          fits: element.scrollWidth <= element.clientWidth + 1,
          mask: getComputedStyle(element.parentElement!).maskImage,
        };
      }),
    )
    .toEqual({ fits: true, mask: "none" });
  const terminalTabGeometry = await terminalLabel.evaluate((label) => {
    const tab = label.closest<HTMLElement>(".tabstrip-tab");
    const viewport = tab?.closest<HTMLElement>(".side-panel__header-tabs");
    if (!tab || !viewport) {
      throw new Error("The terminal tab must belong to the panel's allocated tabs region");
    }
    const newTab = viewport.querySelector<HTMLElement>(":scope > .tabstrip-new");
    return {
      availableWidth: viewport.clientWidth - (newTab?.getBoundingClientRect().width ?? 0),
      tabWidth: tab.getBoundingClientRect().width,
    };
  });
  expect(terminalTabGeometry.tabWidth).toBeLessThan(terminalTabGeometry.availableWidth - 12);
  await captureRichPanel(page, `rails-tabs-single-${themeMode}`);
  const terminalTooltip = terminalLabel.locator("xpath=ancestor::openclaw-tooltip[1]");
  await terminalLabel.locator("..").hover();
  expect(await terminalLabel.getAttribute("data-tooltip-overflow")).toBeNull();
  expect(await terminalTooltip.locator(".tooltip-surface[popover]:popover-open").count()).toBe(0);
  await openFromPlus(page, "Review");
  await rail.getByRole("button", { name: "Close tab: shell 1", exact: true }).click();
  // Closing the last terminal tab removes the Terminal slot; Review stays.
  await expect.poll(() => tabLabels(page)).toEqual(["Review"]);
  // A fitting strip must release its overflow classes and fade mask.
  await expect
    .poll(() =>
      rail.locator(sidePanelTabLabelSelector).evaluateAll((labels) =>
        labels.every((label) => {
          const element = label as HTMLElement;
          const trigger = element.parentElement;
          const mask = trigger ? getComputedStyle(trigger).maskImage : "none";
          return (
            element.scrollWidth <= element.clientWidth + 1 &&
            !element.classList.contains("is-overflowing") &&
            trigger?.classList.contains("has-label-overflow") === false &&
            mask === "none"
          );
        }),
      ),
    )
    .toBe(true);
  await captureRichPanel(page, `rails-tabs-reflow-${themeMode}`);
}

suite.define(() => {
  it.each(["right", "bottom"] as const)(
    "opens topbar surfaces without reserving a stale right dock while the rail is %s-docked",
    async (dock) => {
      await withPage(async (page) => {
        await startChat(page, "light", dock);

        await selectChatLayoutAction(page, "Toggle browser panel");
        await waitForSlot(page, "browser");
        await expect
          .poll(() => dockLayout(page))
          .toMatchObject({
            marginRight: "0px",
            bottomDock: dock === "bottom",
          });
        await openFromPlus(page, "Files");
        await waitForSlot(page, "workspace");
        await expect
          .poll(() => dockLayout(page))
          .toMatchObject({
            marginRight: "0px",
            spansRegion: dock === "bottom",
          });
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "navigates and persists one tabbed side panel in %s theme",
    async (themeMode) => {
      await withPage((page) => exerciseTabbedPanel(page, themeMode), {
        colorScheme: themeMode,
        ...(videoDir && themeMode === "light"
          ? { recordVideo: { dir: videoDir, size: { height: 900, width: 1600 } } }
          : {}),
      });
    },
  );

  it("keeps navigation usable on a mobile viewport", async () => {
    await withPage(
      async (page) => {
        const rail = sidePanel(page);
        const gateway = await startChat(page, "light");
        await activateChatHeaderPanelAction(page, "Show session files");
        await openFromPlus(page, "Terminal");
        await openFromPlus(page, "Side chat");
        await rail.locator(".tabstrip-tab").filter({ hasText: "Side chat" }).click();
        await expect.poll(async () => tabLabels(page)).toEqual(["Files", "zsh", "Side chat"]);
        await expect.poll(() => narrowestRailTabLabel(page)).toBeGreaterThanOrEqual(24);

        const geometry = await sidePanelBody(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.width).toBeGreaterThan(300);

        const companion = rail.locator("openclaw-chat-session-rail");
        const companionGaps = await companion.locator(".chat-session-rail").evaluate((element) => {
          const body = element.closest(".side-panel__panel")?.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return { top: rect.top - (body?.top ?? 0), bottom: rect.bottom - (body?.bottom ?? 0) };
        });
        expect(companionGaps.top).toBeGreaterThanOrEqual(-1);
        expect(companionGaps.bottom).toBeLessThanOrEqual(1);

        const mainComposer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        expect(await mainComposer.isVisible()).toBe(true);
        await selectChatLayoutAction(page, "Minimize side panel");
        await mainComposer.click();
        expect(await mainComposer.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        await selectChatLayoutAction(page, "Side panel");
        const input = companion.getByRole("textbox", { name: "Ask in side chat" });
        await input.fill("Can I use side chat here?");
        await gateway.deferNext("sessions.companion.ask");
        await companion.getByRole("button", { name: "Ask", exact: true }).click();
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toEqual({
          agentId: "main",
          question: "Can I use side chat here?",
          sessionKey,
        });
        const host = page.locator(".chat-mobile-host");
        const actions = page.locator(
          ".agent-chat__header--mobile .chat-header-session-menu__trigger",
        );
        const actionMenu = actions.locator("xpath=ancestor::openclaw-chat-header-session-menu[1]");
        const clear = actionMenu.getByRole("menuitem", { name: "Clear side chat", exact: true });
        const pendingResets = (await gateway.getRequests("sessions.companion.reset")).length;
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await host.waitFor({ state: "hidden" });
        await actions.click();
        await clear.waitFor();
        expect(await clear.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(pendingResets);
        await page.keyboard.press("Escape");
        await clear.waitFor({ state: "hidden" });
        await gateway.resolveDeferred("sessions.companion.ask");
        await page
          .locator(".agent-chat__header--mobile")
          .getByRole("button", { name: "Panels", exact: true })
          .click();
        await companion
          .getByText("The mobile side chat stayed inside its panel.", { exact: true })
          .waitFor();
        const resets = (await gateway.getRequests("sessions.companion.reset")).length;
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await host.waitFor({ state: "hidden" });
        await actions.click();
        await clear.waitFor();
        await expect.poll(() => clear.isEnabled()).toBe(true);
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(resets);
        await captureRichPanel(page, "rails-side-chat-mobile-light");
        await page.keyboard.press("Escape");
        await clear.waitFor({ state: "hidden" });
        await page
          .locator(".agent-chat__header--mobile")
          .getByRole("button", { name: "Panels", exact: true })
          .click();
        await companion.waitFor();
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(resets);
        await companion
          .getByText("The mobile side chat stayed inside its panel.", { exact: true })
          .waitFor();
        expect((await host.boundingBox())!.width).toBeCloseTo(390, 0);
        await captureRichPanel(page, "rails-tabs-mobile-light");
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await host.waitFor({ state: "hidden" });
        await actions.click();
        await expect.poll(() => clear.isEnabled()).toBe(true);
        await clear.click();
        const reset = await gateway.waitForRequest("sessions.companion.reset", { after: resets });
        expect(reset.params).toEqual({ sessionKey, agentId: "main" });
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(resets + 1);
        await clear.waitFor({ state: "hidden" });
        await page
          .locator(".agent-chat__header--mobile")
          .getByRole("button", { name: "Panels", exact: true })
          .click();
        await companion
          .getByText("Answers come from this session's transcript and its project files.", {
            exact: true,
          })
          .waitFor();
        expect(await companion.locator(".chat-session-rail__exchange").count()).toBe(0);
        expect(await input.inputValue()).toBe("");
        expect(await input.isEditable()).toBe(true);
        expect(await companion.getByRole("button", { name: "Ask", exact: true }).isDisabled()).toBe(
          true,
        );
      },
      { viewport: { height: 844, width: 390 } },
    );
  });
});
