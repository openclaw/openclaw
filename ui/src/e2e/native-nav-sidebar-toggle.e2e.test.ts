import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { focusChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createNativeNavPageOpener } from "./native-nav-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native-nav sidebar toggle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
let TOAST_PROOF_DIR: string;
beforeEach(() => {
  TOAST_PROOF_DIR = createControlUiE2eArtifactDir("toast-layering");
  railProofDir = railProofDirParent
    ? createControlUiE2eArtifactDir("native-nav-sidebar-toggle", railProofDirParent)
    : undefined;
});
const railProofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let railProofDir: string | undefined;
const limitedScopes = ["operator.read", "operator.write"];
const expectFocused = (target: Locator) =>
  expect.poll(() => target.evaluate((element) => element === document.activeElement)).toBe(true);
const expectShellClass = (page: Page, name: string, present = true) => {
  const assertion = expect.poll(() => page.locator(".shell").getAttribute("class"));
  return present ? assertion.toContain(name) : assertion.not.toContain(name);
};
const nativeEvent = (page: Page, type: string) =>
  page.evaluate((name) => window.dispatchEvent(new CustomEvent(name)), type);
const visible = (target: Locator, value = true) =>
  expect.poll(() => target.isVisible()).toBe(value);
const count = (target: Locator, value: number) => expect.poll(() => target.count()).toBe(value);
const attr = (target: Locator, name: string, value: string | null) =>
  expect.poll(() => target.getAttribute(name)).toBe(value);
async function expectStyles(target: Locator, expected: Record<string, string>, length = 1) {
  await expect
    .poll(() =>
      target.evaluateAll(
        (elements, names) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
          }),
        Object.keys(expected),
      ),
    )
    .toEqual(Array.from({ length }, () => expected));
}
async function expectBelow(lower: Locator, upper: Locator, inclusive: boolean) {
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([lower.boundingBox(), upper.boundingBox()]);
      return Boolean(a && b && (inclusive ? a.y >= b.y + b.height : a.y > b.y + b.height));
    })
    .toBe(true);
}
type NavWindow = Window & {
  openclawNavMessages?: Array<{ type?: string; width?: number; collapsed?: boolean }>;
};
const navState = (page: Page, collapsed?: boolean) =>
  page.evaluate(
    (desired) =>
      (window as NavWindow).openclawNavMessages?.find(
        (message) =>
          message?.type === "nav-state" && (desired === undefined || message.collapsed === desired),
      ),
    collapsed,
  );
async function capture(page: Page, directory: string | undefined, file: string, fullPage = false) {
  if (directory) {
    await page.screenshot({ animations: "disabled", fullPage, path: path.join(directory, file) });
  }
}
const boxes = async (controls: Locator) =>
  Promise.all(
    Array.from({ length: await controls.count() }, (_, index) => controls.nth(index).boundingBox()),
  );
const UPDATE_AVAILABLE = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
} as const;
const TOAST_SCENARIO: ControlUiMockGatewayScenario = {
  featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
  methodResponses: {
    "sessions.list": chatSessionListResponse(),
    "sessions.catalog.list": {
      catalogs: [
        {
          id: "codex",
          label: "Codex",
          capabilities: { archive: true, continueSession: true },
          hosts: [
            {
              connected: true,
              hostId: "gateway:local",
              kind: "gateway",
              label: "Local Codex",
              sessions: [
                {
                  archived: false,
                  canArchive: true,
                  canContinue: true,
                  name: "Toast routing proof",
                  status: "idle",
                  threadId: "toast-routing-proof",
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

suite.define(() => {
  const openPage = createNativeNavPageOpener(suite);

  it("keeps sidebar rail toggles in plain browsers", async () => {
    const page = await openPage({ nativeNav: false });
    expect(
      await page.evaluate(
        (patterns) => ({
          titlebarRegistered: customElements.get("openclaw-macos-titlebar-controls") !== undefined,
          requested: patterns.map((pattern) =>
            performance
              .getEntriesByType("resource")
              .some((entry) => new RegExp(pattern, "u").test(entry.name)),
          ),
        }),
        [
          "components/macos-titlebar-controls.runtime-solid.tsx",
          "app/nav-drawer-swipe.runtime.ts",
        ].map((file) => controlUiE2eBuiltModuleRequest(`ui/src/${file}`).source),
      ),
    ).toEqual({ titlebarRegistered: false, requested: [false, false] });
    const toggle = page.locator('[data-navigation-view="sessions"]');
    const sidebarPanel = page.locator(".sidebar-shell");
    await visible(sidebarPanel);
    await toggle.click();
    await visible(sidebarPanel, false);
    await toggle.click();
    await visible(sidebarPanel);

    await page.locator(".sidebar-issues-button").click();
    const desktopInbox = page.locator("#sidebar-issues-panel");
    await desktopInbox.waitFor();
    await attr(desktopInbox, "aria-modal", null);
    await page.keyboard.press("Escape");
  });

  it.each([1280, 900])(
    "animates sidebar clicks but settles shortcut toggles before the next frame at %ipx",
    async (viewportWidth) => {
      const page = await openPage({
        nativeNav: false,
        width: viewportWidth,
        scenario: {
          historyMessages: [
            { role: "user", content: [{ type: "text", text: "Review the navigation changes." }] },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The sidebar is ready. Use its button or keyboard shortcut to open and close it.",
                },
              ],
            },
          ],
          methodResponses: { "sessions.list": chatSessionListResponse() },
        },
      });
      await page
        .getByText(
          "The sidebar is ready. Use its button or keyboard shortcut to open and close it.",
          { exact: true },
        )
        .waitFor();
      await page.locator(".chat-pane--history-loading").waitFor({ state: "hidden" });
      let sampleIndex = 0;
      const sampleToggle = async (input: "click" | "shortcut") => {
        const sampled = await page.evaluate(async (interaction) => {
          const shell = document.querySelector<HTMLElement>(".shell")!;
          const navigation = document.querySelector<HTMLElement>(".shell-nav")!;
          const mobile = shell.classList.contains("shell--mobile-nav");
          const width = () =>
            mobile
              ? navigation.getBoundingClientRect().right
              : navigation.getBoundingClientRect().width;
          const backdrop = shell.querySelector<HTMLElement>(".shell-nav-backdrop")!;
          const animations = () =>
            [shell, navigation, backdrop].flatMap((element) => element.getAnimations());
          for (const animation of animations()) {
            animation.finish();
          }
          const start = width();
          if (interaction === "shortcut") {
            const mac = navigator.platform.startsWith("Mac");
            document.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "b",
                code: "KeyB",
                metaKey: mac,
                ctrlKey: !mac,
                bubbles: true,
                cancelable: true,
              }),
            );
          } else {
            const toggle = mobile
              ? shell.classList.contains("shell--nav-drawer-open")
                ? backdrop
                : [...document.querySelectorAll<HTMLElement>('[aria-label="Expand sidebar"]')].find(
                    (element) => element.checkVisibility(),
                  )!
              : document.querySelector<HTMLElement>('[data-navigation-view="sessions"]')!;
            toggle.click();
          }
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          const firstFrame = width();
          const current = animations();
          const moving = current.some((animation) => animation.playState === "running");
          for (const animation of current) {
            animation.pause();
          }
          return { start, firstFrame, moving };
        }, input);
        if (railProofDir) {
          await page.screenshot({ path: path.join(railProofDir, `${sampleIndex++}-${input}.png`) });
        }
        const end = await page.locator(".shell").evaluate((shell) => {
          const navigation = shell.querySelector(".shell-nav")!;
          const backdrop = shell.querySelector<HTMLElement>(".shell-nav-backdrop")!;
          for (const element of [shell, navigation, backdrop]) {
            for (const animation of element.getAnimations()) {
              animation.finish();
            }
          }
          const bounds = navigation.getBoundingClientRect();
          return shell.classList.contains("shell--mobile-nav") ? bounds.right : bounds.width;
        });
        return { ...sampled, end };
      };

      for (const input of ["click", "shortcut", "shortcut", "click"] as const) {
        const sample = await sampleToggle(input);
        expect(Math.abs(sample.end - sample.start)).toBeGreaterThan(100);
        if (input === "shortcut") {
          expect.soft(sample.firstFrame).toBe(sample.end);
          expect.soft(sample.moving).toBe(false);
        } else {
          expect(sample.moving).toBe(true);
          expect(Math.abs(sample.firstFrame - sample.end)).toBeGreaterThan(1);
        }
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await sampleToggle("click");
      expect(reduced.firstFrame).toBe(reduced.end);
      expect(reduced.moving).toBe(false);
    },
  );

  it("keeps restored sidebar focus from opening its tooltip", async () => {
    const page = await openPage({ hasTouch: true, nativeNav: false });
    const toggle = page.locator('[data-navigation-view="sessions"]');
    const sidebarPanel = page.locator(".sidebar-shell");
    const openTooltip = page.locator("openclaw-tooltip[open]");
    await visible(sidebarPanel);

    // Safari tap leaves post-collapse focus restoration to the shell.
    await toggle.evaluate((element) => {
      for (const type of ["pointerdown", "pointerup"]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch" }));
      }
      (element as HTMLElement).click();
    });

    await visible(sidebarPanel, false);
    await expectFocused(toggle);
    await count(openTooltip, 0);

    await page.keyboard.press("Enter");
    await visible(sidebarPanel);
    expect(await openTooltip.count()).toBe(0);

    await nativeEvent(page, "openclaw:native-toggle-sidebar");
    await visible(sidebarPanel, false);
    await expectFocused(toggle);
    await count(openTooltip, 0);

    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        openTooltip.evaluate((tooltip) => (tooltip as HTMLElement & { content: string }).content),
      )
      .toBe("Sessions");
    await page.keyboard.press("Enter");
    await visible(sidebarPanel);
    expect(await openTooltip.count()).toBe(0);
  });

  it("hides the web chrome cluster when the native titlebar toggle is present", async () => {
    const page = await openPage({ nativeNav: true });

    await expect.poll(() => navState(page)).toMatchObject({ type: "nav-state", collapsed: false });
    expect((await navState(page))?.width ?? 0).toBeGreaterThan(0);
    await visible(page.locator(".sidebar-brand__search"));

    await nativeEvent(page, "openclaw:native-toggle-sidebar");
    await expectShellClass(page, "shell--nav-collapsed");
    await expect.poll(() => navState(page, true)).toMatchObject({ collapsed: true });
    await visible(page.locator(".shell-chrome-controls"), false);
    await expectFocused(page.locator('[data-navigation-view="sessions"]'));

    await nativeEvent(page, "openclaw:native-open-search");
    await visible(page.locator(".cmd-palette-overlay"));

    await nativeEvent(page, "openclaw:native-new-session");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
  });

  it("hosts navigation, search, sessions, and history in web titlebar chrome", async () => {
    const page = await openPage({
      colorScheme: "dark",
      scenario: {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "update.run"],
        operatorScopes: ["operator.admin", "operator.read"],
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: {
          channel: "stable",
          autoEnabled: false,
          target: { kind: "package", version: "2.0.0" },
        },
      },
      webChrome: true,
    });
    const toolbar = page.locator(".macos-titlebar-controls");
    await visible(toolbar);
    await visible(page.locator(".shell-chrome-controls"), false);
    const sidebarNewThread = page.locator(".sidebar-rail .sidebar-new-session");
    await visible(sidebarNewThread);
    await expectStyles(sidebarNewThread, { "border-top-style": "none", "box-shadow": "none" });
    await attr(sidebarNewThread, "aria-disabled", null);
    await page.keyboard.press("Tab");
    await sidebarNewThread.focus();
    await expect
      .poll(() =>
        sidebarNewThread.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            focusVisible: element.matches(":focus-visible"),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
          };
        }),
      )
      .toEqual({ focusVisible: true, outlineStyle: "solid", outlineWidth: "2px" });
    const back = toolbar.getByRole("button", { name: "Back" });
    const forward = toolbar.getByRole("button", { name: "Forward" });
    const search = page.locator(".sidebar-brand__search");
    const newThread = page.locator(".sidebar-rail__create a, .sidebar-rail__create button");
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await visible(search);
    await visible(newThread);
    await page.locator(".sidebar-issues-button__count").waitFor();

    await page.locator(".sidebar-session-toolbar__collapse").click();
    await expectShellClass(page, "shell--nav-collapsed");
    await visible(newThread);
    await page.locator(".sidebar-rail__bottom .sidebar-issues-button").waitFor();
    await page.locator(".sidebar-rail__bottom .sidebar-issues-button__count").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await waitForLayoutSettled(
      page,
      ".macos-titlebar-controls, .sidebar-rail__bottom, .chat-pane-cache__pane--visible .chat-pane__crumbs",
    );
    const toolbarBox = await toolbar.boundingBox();
    const rail = page.locator(".sidebar-rail");
    const attention = rail.locator(".sidebar-issues-button");
    const attentionBox = await attention.boundingBox();
    const railBox = await rail.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(attentionBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(railBox!.width).toBe(52);
    expect(await page.locator(".sidebar-shell").isVisible()).toBe(false);
    expect(await page.locator(".sidebar-attention--floating").count()).toBe(0);
    expect(attentionBox!.x).toBeGreaterThanOrEqual(railBox!.x);
    expect(attentionBox!.x + attentionBox!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width);
    expect(attentionBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height + 4);
    const titleBox = await page
      .locator(".chat-pane-cache__pane--visible .chat-pane__crumbs:visible")
      .first()
      .boundingBox();
    expect(titleBox).not.toBeNull();
    expect(titleBox!.x - (toolbarBox!.x + toolbarBox!.width)).toBeGreaterThanOrEqual(8);
    const titlebarControls = toolbar.locator("button:visible");
    const centerlines = await titlebarControls.evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    expect(centerlines).toHaveLength(2);
    for (const centerline of centerlines.slice(1)) {
      expect(centerline).toBeCloseTo(centerlines[0]!, 1);
    }
    const footerControls = rail.locator(
      ".sidebar-footer-bar__home, .sidebar-issues-button, .sidebar-identity-card",
    );
    const footerBoxes = await footerControls.evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    expect(footerBoxes).toHaveLength(3);
    for (const [index, box] of footerBoxes.entries()) {
      expect(box.x + box.width / 2).toBeCloseTo(railBox!.x + (railBox!.width - 1) / 2, 1);
      expect(box.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height + 4);
      expect(box.y + box.height).toBeLessThanOrEqual(railBox!.y + railBox!.height);
      if (index > 0) {
        const previous = footerBoxes[index - 1]!;
        expect(box.y - (previous.y + previous.height)).toBeGreaterThanOrEqual(4);
      }
    }
    const shellControls = page.locator(
      ".macos-titlebar-controls button:visible, .sidebar-rail__bottom .sidebar-issues-button:visible",
    );
    await page.mouse.move(600, 400);
    await capture(page, railProofDir, "native-web-top-left-controls.png");
    await expectStyles(
      shellControls,
      {
        "border-top-width": "0px",
        "background-color": "rgba(0, 0, 0, 0)",
        "box-shadow": "none",
      },
      3,
    );
    const inbox = attention;
    await inbox.hover();
    expect(await inbox.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    // Home is unavailable in this narrow feature catalog; enter Inbox from the profile button.
    await rail.locator(".sidebar-identity-card").focus();
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() => inbox.evaluate((button) => button.matches(":focus-visible")))
      .toBe(true);
    expect(await inbox.evaluate((button) => getComputedStyle(button).boxShadow)).not.toBe("none");
    await page.keyboard.press("Enter");
    await visible(page.locator("#sidebar-issues-panel"));
    await page.keyboard.press("Escape");
    await attr(inbox, "aria-expanded", "false");

    await search.click();
    await visible(page.locator(".cmd-palette-overlay"));
    await page.keyboard.press("Escape");

    for (const canGoBack of [true, false]) {
      await page.evaluate(
        (backward) =>
          window.dispatchEvent(
            new CustomEvent("openclaw:native-history-state", {
              detail: { canGoBack: backward, canGoForward: !backward },
            }),
          ),
        canGoBack,
      );
      await expect
        .poll(async () => [await back.isDisabled(), await forward.isDisabled()])
        .toEqual([!canGoBack, canGoBack]);
    }

    await newThread.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await page.locator(".shell-chrome-controls__nav-toggle").click();
    await expectShellClass(page, "shell--nav-collapsed", false);
  });

  it.each([
    { deviceLess: false, label: "ordinary", operatorScopes: undefined },
    { deviceLess: true, label: "limited-access", operatorScopes: limitedScopes },
  ])("keeps focused main controls clear of $label web titlebar chrome", async (testCase) => {
    const page = await openPage({
      deviceLess: testCase.deviceLess,
      scenario: testCase.operatorScopes
        ? {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "device.scopes.requestUpgrade",
              "device.scopes.waitUpgrade",
              "sessions.create",
            ],
            methodResponses: { "sessions.list": chatSessionListResponse() },
            operatorScopes: testCase.operatorScopes,
          }
        : undefined,
      webChrome: true,
      width: 1280,
    });
    await page.locator(".sidebar-session-toolbar__collapse").click();
    await openChatSidePanelType(page, "Side chat");
    await focusChatSidePanel(page);

    const shellControls = page.locator(
      ".macos-titlebar-controls button:visible, .sidebar-rail__bottom button:visible",
    );
    const panelControls = page.locator(
      '[data-region-header="side"] .side-panel__actions button:visible',
    );
    const shellBoxes = await boxes(shellControls);
    const panelBoxes = await boxes(panelControls);
    expect(shellBoxes.length).toBeGreaterThan(0);
    expect(panelBoxes.length).toBeGreaterThan(0);
    for (const panelBox of panelBoxes) {
      expect(panelBox).not.toBeNull();
      for (const shellBox of shellBoxes) {
        expect(shellBox).not.toBeNull();
        expect(
          panelBox!.x >= shellBox!.x + shellBox!.width + 4 ||
            panelBox!.x + panelBox!.width <= shellBox!.x - 4 ||
            panelBox!.y >= shellBox!.y + shellBox!.height + 4 ||
            panelBox!.y + panelBox!.height <= shellBox!.y - 4,
        ).toBe(true);
      }
    }
    if (testCase.deviceLess) {
      await page.locator(".sidebar-rail__bottom .sidebar-issues-button__count").waitFor();
      expect(await page.locator(".scope-upgrade-shell-status").count()).toBe(0);
    }
    for (let index = 0; index < (await panelControls.count()); index += 1) {
      await panelControls.nth(index).click({ trial: true });
    }
    await capture(
      page,
      railProofDir,
      `native-web-${testCase.deviceLess ? "limited" : "ordinary"}-collapsed.png`,
      true,
    );
  });

  it("keeps the mobile drawer modal, keyboard-contained, and focus-restoring", async () => {
    const page = await openPage({
      nativeNav: false,
      scenario: {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      },
      width: 900,
    });
    const navigation = page.locator(".shell-nav");
    const dialog = page.getByRole("dialog", { name: "Navigation" });
    const trigger = navigationDrawerToggle(page);
    const readFocusLocation = () =>
      page.evaluate(() => {
        // Native dialog tab order may hand focus to browser chrome, but not the inert page.
        if (!document.hasFocus()) {
          return "browser-chrome";
        }
        return document.activeElement?.closest(".shell-nav") ? "navigation" : "page";
      });

    await attr(navigation, "inert", "");
    await count(page.locator(".shell-nav-backdrop"), 1);
    await visible(dialog, false);
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".shell-nav") !== null))
      .toBe(false);

    await attr(trigger, "aria-expanded", "false");
    await attr(trigger, "aria-label", "Expand sidebar");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect.poll(readFocusLocation).toBe("navigation");

    await expectShellClass(page, "shell--nav-drawer-open");
    await attr(navigation, "inert", null);
    await visible(dialog);
    await expect
      .poll(() => page.locator(".shell-nav-backdrop").getAttribute("aria-hidden"))
      .toBe("true");
    await attr(trigger, "aria-expanded", "true");
    await attr(trigger, "aria-label", "Collapse sidebar");

    for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"] as const) {
      await page.keyboard.press(key);
      await expect.poll(readFocusLocation).not.toBe("page");
    }

    expect(
      await page.locator("#control-ui-main").evaluate((element) => {
        element.focus();
        return element === document.activeElement;
      }),
    ).toBe(false);

    await navigation.locator('[data-navigation-view="sessions"]').click();
    const row = navigation.locator(".sidebar-recent-session").first();
    await row.hover();
    await row.click({ button: "right" });
    const sessionMenu = page.getByRole("menu", { name: /Actions for/ });
    await visible(sessionMenu);
    await page.keyboard.press("Escape");
    await count(sessionMenu, 0);
    await visible(dialog);

    // Unlike a native picker, a disclosure can open in inert content to probe Escape ownership.
    await page.evaluate(() => {
      const details = document.createElement("details");
      details.id = "background-navigation-disclosure";
      details.className = "chat-controls__inline-select";
      details.open = true;
      document.querySelector(".chat-controls__model-picker")!.parentElement!.append(details);
    });
    const pageDetails = page.locator("#background-navigation-disclosure");
    await attr(pageDetails, "open", "");
    await page.keyboard.press("Escape");
    await attr(pageDetails, "open", "");
    await visible(dialog, false);
    await pageDetails.evaluate((element) => element.remove());

    await trigger.click();
    await visible(dialog);

    await page.keyboard.press("Escape");
    await expectShellClass(page, "shell--nav-drawer-open", false);
    await attr(trigger, "aria-expanded", "false");
    await attr(trigger, "aria-label", "Expand sidebar");
    await expectFocused(trigger);

    await trigger.click();
    const inbox = navigation.locator(".sidebar-issues-button");
    await inbox.click();
    const attentionDialog = page.getByRole("dialog", { name: "Inbox" });
    await attentionDialog.waitFor();
    await attr(attentionDialog, "aria-modal", "true");
    const attentionControls = attentionDialog.locator("button, a[href], summary");
    const lastAttentionControl = attentionControls.last();
    await lastAttentionControl.focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest("#sidebar-issues-panel") !== null),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await count(attentionDialog, 0);
    await visible(dialog);

    await nativeEvent(page, "openclaw:debug-overlay-request");
    const debugOverlay = page.locator(".debug-overlay");
    await debugOverlay.waitFor();
    await visible(dialog, false);
    await page.keyboard.press("Escape");
    await count(debugOverlay, 0);

    await trigger.click();
    await page.mouse.click(899, 450);
    await visible(dialog, false);
    await expectFocused(trigger);

    await trigger.click();
    await navigation.locator(".sidebar-issues-button").click();
    await attentionDialog.waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await count(attentionDialog, 0);
    await attr(navigation, "inert", null);
    await expect.poll(() => navigation.getAttribute("class")).not.toContain("nav-drawer");
  });

  it.each([
    {
      colorScheme: "dark",
      finalLayout: "compact",
      finalViewport: { height: 844, width: 390 },
    },
    {
      colorScheme: "light",
      finalLayout: "desktop",
      finalViewport: { height: 900, width: 1280 },
    },
  ] as const)(
    "keeps drawer toast actionable and handed-off toast clear of chat chrome in $finalLayout $colorScheme mode",
    async ({ colorScheme, finalLayout, finalViewport }) => {
      const page = await openPage({
        colorScheme,
        height: 844,
        nativeNav: false,
        scenario: TOAST_SCENARIO,
        width: 390,
      });
      const drawer = page.locator(".shell-nav.nav-drawer");
      const dialog = page.getByRole("dialog", { name: "Navigation" });
      await navigationDrawerToggle(page).click();
      await visible(dialog);

      const catalog = drawer.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      await catalog.locator(".sidebar-recent-sessions__head").hover();
      await catalog.locator('[data-session-catalog-view-menu="codex"]').click();
      await page
        .locator('[data-value="hide-catalog"]')
        .evaluate((element) => (element as HTMLElement).click());
      const host = drawer.locator("openclaw-toast-host");
      const toast = host.locator(".app-toast");
      await toast.waitFor();
      await expect.poll(() => toast.textContent()).toContain("Codex hidden");
      const drawerToastGeometry = await host.evaluate((node) => {
        const toastElement = node.querySelector<HTMLElement>(".app-toast");
        return {
          computedTop: toastElement
            ? Math.round(Number.parseFloat(getComputedStyle(toastElement).top))
            : null,
          placement: node.dataset.toastPlacement,
        };
      });
      expect(drawerToastGeometry).toEqual({ placement: "overlay", computedTop: 20 });
      const dismiss = toast.getByRole("button", { name: "Dismiss" });
      await dismiss.click({ trial: true });

      await capture(page, TOAST_PROOF_DIR, `mobile-drawer-toast-${colorScheme}.png`);
      if (finalLayout === "compact") {
        await page.keyboard.press("Escape");
        await visible(dialog, false);
      } else {
        await page.setViewportSize(finalViewport);
        await count(drawer, 0);
      }
      expect(page.viewportSize()).toEqual(finalViewport);
      const retainedHost = page.locator(".shell > openclaw-toast-host");
      await attr(retainedHost, "data-toast-placement", "shell");
      const retainedToast = retainedHost.locator(".app-toast");
      await expect.poll(() => retainedToast.textContent()).toContain("Codex hidden");
      const header = page
        .locator(
          finalLayout === "compact"
            ? ".agent-chat__header--mobile:visible"
            : ".chat-pane__header:visible",
        )
        .first();
      await expectBelow(retainedToast, header, true);
      await expectBelow(page.locator(".agent-chat__composer-shell"), retainedToast, false);
      await capture(page, TOAST_PROOF_DIR, `handed-off-toast-${finalLayout}-${colorScheme}.png`);
      await retainedToast.getByRole("button", { name: "Dismiss" }).click();
      await visible(retainedToast, false);
    },
  );

  it("keeps the sidebar rail beside a half-width native link browser", async () => {
    const page = await openPage({ webChrome: true, width: 620 });
    await visible(page.locator(".macos-titlebar-controls"));
    await visible(page.locator(".sidebar-resizer"));
    await visible(page.locator(".shell-nav"));
    await expectShellClass(page, "shell--mobile-nav", false);
    await visible(page.locator(".topbar-nav-toggle"), false);

    await page.setViewportSize({ width: 560, height: 900 });
    await expectShellClass(page, "shell--mobile-nav");
    await visible(page.locator(".macos-titlebar-controls"), false);
    await visible(page.locator(".topbar-nav-toggle"));
    // Keep the brand clear of the native traffic-light cluster.
    await expect
      .poll(() =>
        page.locator(".topbar-brand").evaluate((element) => element.getBoundingClientRect().x),
      )
      .toBe(92);
    await page.setViewportSize({ width: 620, height: 900 });
    await expectShellClass(page, "shell--mobile-nav", false);
    await visible(page.locator(".shell-nav"));
  });

  it("hides the drawer hamburger at narrow widths when the native toggle is present", async () => {
    const page = await openPage({ nativeNav: true, width: 900 });
    // The native titlebar toggle drives the drawer via the window event, so
    // the web hamburger would be a duplicate control.
    await visible(page.locator(".topbar-nav-toggle"), false);
    await nativeEvent(page, "openclaw:native-toggle-sidebar");
    await expectShellClass(page, "shell--nav-drawer-open");
    // Closing through the native toggle restores focus to the content anchor,
    // not the hidden hamburger the drawer recorded as its trigger.
    await nativeEvent(page, "openclaw:native-toggle-sidebar");
    await expectShellClass(page, "shell--nav-drawer-open", false);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);
  });
});
