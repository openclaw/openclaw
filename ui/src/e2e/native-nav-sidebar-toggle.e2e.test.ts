// Shipped apps stamp `openclaw-native-nav`; current apps advertise web chrome
// at document start and stamp `openclaw-native-web-chrome` at document end.
// Plain browsers keep their normal in-page controls.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
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
});
const railProofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let railProofDir: string | undefined;
beforeEach(() => {
  railProofDir = railProofDirParent
    ? createControlUiE2eArtifactDir("native-nav-sidebar-toggle", railProofDirParent)
    : undefined;
});
const limitedScopes = ["operator.read", "operator.write"];
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

  it("keeps the web expand/collapse controls in plain browsers", async () => {
    const page = await openPage({ nativeNav: false });
    const titlebarRequest = controlUiE2eBuiltModuleRequest(
      "ui/src/components/macos-titlebar-controls.runtime.ts",
    );
    const swipeRequest = controlUiE2eBuiltModuleRequest("ui/src/app/nav-drawer-swipe.runtime.ts");

    expect(
      await page.evaluate(
        (requestPattern) => ({
          titlebarRegistered: customElements.get("openclaw-macos-titlebar-controls") !== undefined,
          titlebarRequested: performance
            .getEntriesByType("resource")
            .some((entry) => new RegExp(requestPattern, "u").test(entry.name)),
        }),
        titlebarRequest.source,
      ),
    ).toEqual({ titlebarRegistered: false, titlebarRequested: false });
    expect(
      await page.evaluate(
        (requestPattern) =>
          performance
            .getEntriesByType("resource")
            .some((entry) => new RegExp(requestPattern, "u").test(entry.name)),
        swipeRequest.source,
      ),
    ).toBe(false);
    const collapse = page.locator(".sidebar-brand__collapse");
    await expect.poll(() => collapse.isVisible()).toBe(true);
    await collapse.click();
    const expand = page.locator(".shell-chrome-controls__nav-toggle");
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expand.click();
    await expect.poll(() => collapse.isVisible()).toBe(true);

    await page.locator(".sidebar-issues-button").click();
    const desktopInbox = page.locator("#sidebar-issues-panel");
    await desktopInbox.waitFor();
    await expect.poll(() => desktopInbox.getAttribute("aria-modal")).toBeNull();
    await page.keyboard.press("Escape");
  });

  it("keeps restored sidebar focus from opening its tooltip", async () => {
    const page = await openPage({ hasTouch: true, nativeNav: false });
    const toggle = page.locator(".sidebar-brand__collapse");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");

    // Safari does not focus buttons on tap. Reproduce that ordering so the
    // shell's post-collapse focus, rather than the pointer itself, owns focus.
    await toggle.evaluate((element) => {
      for (const type of ["pointerdown", "pointerup"]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch" }));
      }
      (element as HTMLElement).click();
    });

    const expand = page.locator(".shell-chrome-controls__nav-toggle");
    const tooltip = expand.locator("xpath=..");
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => expand.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => tooltip.getAttribute("open")).toBeNull();

    await page.keyboard.press("Enter");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(await page.locator("openclaw-tooltip[open]").count()).toBe(0);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect.poll(() => expand.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => expand.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => tooltip.getAttribute("open")).toBeNull();

    // A later, explicit keyboard return still reveals the accessible hint.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => tooltip.getAttribute("open")).toBe("");
    await page.keyboard.press("Enter");
    await expect.poll(() => toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(await page.locator("openclaw-tooltip[open]").count()).toBe(0);
  });

  it("hides the web chrome cluster when the native titlebar toggle is present", async () => {
    const page = await openPage({ nativeNav: true });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const messages = (window as Window & { openclawNavMessages?: unknown[] })
            .openclawNavMessages;
          return messages?.find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { type?: string }).type === "nav-state",
          );
        }),
      )
      .toMatchObject({ type: "nav-state", collapsed: false });
    const initialWidth = await page.evaluate(() => {
      const messages = (window as Window & { openclawNavMessages?: unknown[] }).openclawNavMessages;
      const message = messages?.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { type?: string }).type === "nav-state",
      );
      return (message as { width?: number } | undefined)?.width ?? 0;
    });
    expect(initialWidth).toBeGreaterThan(0);

    // Expanded native-nav hosts keep sidebar search (no native search control
    // exists while the rail is open) but hide the duplicate web nav toggle.
    await expect.poll(() => page.locator(".sidebar-brand__search").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".sidebar-brand__collapse").isVisible()).toBe(false);

    // Collapse through the native titlebar path; the whole web chrome cluster
    // hides (native titlebar provides search and new-thread while collapsed).
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & { openclawNavMessages?: Array<{ collapsed?: boolean }> }
          ).openclawNavMessages?.some((message) => message.collapsed === true),
        ),
      )
      .toBe(true);
    await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);
    // With the in-page expand control hidden, collapse anchors keyboard focus
    // on the content column instead of stranding it on the body.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-open-search"));
    });
    await expect.poll(() => page.locator(".cmd-palette-overlay").isVisible()).toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-new-session"));
    });
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
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);
    const sidebarBrand = page.locator(".sidebar-brand");
    const sidebarNewThread = sidebarBrand.locator(".sidebar-brand__new-thread");
    await expect.poll(() => sidebarNewThread.isVisible()).toBe(true);
    await expect
      .poll(() =>
        sidebarNewThread.evaluate((element) => {
          const style = getComputedStyle(element);
          return { borderStyle: style.borderTopStyle, boxShadow: style.boxShadow };
        }),
      )
      .toEqual({ borderStyle: "none", boxShadow: "none" });
    await page.keyboard.press("Tab");
    await sidebarNewThread.focus();
    await expect
      .poll(() =>
        sidebarNewThread.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            focusVisible: element.matches(":focus-visible"),
            boxShadow: style.boxShadow,
          };
        }),
      )
      .toEqual({ focusVisible: true, boxShadow: expect.not.stringMatching(/^none$/) });
    await expect
      .poll(async () => {
        const [brandBox, newThreadBox] = await Promise.all([
          sidebarBrand.boundingBox(),
          sidebarNewThread.boundingBox(),
        ]);
        if (!brandBox || !newThreadBox) {
          return null;
        }
        return Math.round(brandBox.x + brandBox.width - (newThreadBox.x + newThreadBox.width));
      })
      .toBe(2);

    const back = toolbar.getByRole("button", { name: "Back" });
    const forward = toolbar.getByRole("button", { name: "Forward" });
    const search = toolbar.getByRole("button", { name: "Open command palette" });
    const newThread = toolbar.getByRole("button", { name: "New session" });
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await expect.poll(() => search.isVisible()).toBe(true);
    await expect.poll(() => newThread.count()).toBe(0);
    await page.locator(".sidebar-issues-button__count").waitFor();

    await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    await expect.poll(() => newThread.isVisible()).toBe(true);
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
    expect(centerlines).toHaveLength(5);
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
    if (railProofDir) {
      await page.screenshot({
        animations: "disabled",
        path: path.join(railProofDir, "native-web-top-left-controls.png"),
      });
    }
    await expect
      .poll(() =>
        shellControls.evaluateAll((buttons) =>
          buttons.map((button) => {
            const style = getComputedStyle(button);
            return {
              border: style.borderTopWidth,
              background: style.backgroundColor,
              shadow: style.boxShadow,
            };
          }),
        ),
      )
      .toEqual(
        Array.from({ length: 6 }, () => ({
          border: "0px",
          background: "rgba(0, 0, 0, 0)",
          shadow: "none",
        })),
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
    await expect.poll(() => page.locator("#sidebar-issues-panel").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => inbox.getAttribute("aria-expanded")).toBe("false");

    await search.click();
    await expect.poll(() => page.locator(".cmd-palette-overlay").isVisible()).toBe(true);
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: true, canGoForward: false },
        }),
      );
    });
    await expect.poll(() => back.isDisabled()).toBe(false);
    await expect.poll(() => forward.isDisabled()).toBe(true);
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: false, canGoForward: true },
        }),
      );
    });
    await expect.poll(() => back.isDisabled()).toBe(true);
    await expect.poll(() => forward.isDisabled()).toBe(false);

    await newThread.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await toolbar.getByRole("button", { name: "Expand sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-collapsed");
  });

  it.each([
    {
      deviceLess: false,
      label: "ordinary collapsed-navigation",
      navCollapsed: true,
      operatorScopes: undefined,
      width: 1280,
    },
    {
      deviceLess: true,
      label: "limited-access collapsed-navigation",
      navCollapsed: true,
      operatorScopes: limitedScopes,
      width: 1280,
    },
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
      width: testCase.width,
    });
    const toolbar = page.locator(".macos-titlebar-controls");
    if (testCase.navCollapsed) {
      await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    }
    await openChatSidePanelType(page, "Side chat");
    await focusChatSidePanel(page);

    const shellControls = page.locator(
      ".macos-titlebar-controls button:visible, .sidebar-rail__bottom button:visible",
    );
    const panelControls = page.locator(".chat-pane__actions button:visible");
    const shellBoxes = await Promise.all(
      Array.from({ length: await shellControls.count() }, (_, index) =>
        shellControls.nth(index).boundingBox(),
      ),
    );
    const panelBoxes = await Promise.all(
      Array.from({ length: await panelControls.count() }, (_, index) =>
        panelControls.nth(index).boundingBox(),
      ),
    );
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
    if (railProofDir) {
      await page.screenshot({
        fullPage: true,
        path: path.join(
          railProofDir,
          `native-web-${testCase.deviceLess ? "limited" : "ordinary"}-${testCase.navCollapsed ? "collapsed" : "expanded"}.png`,
        ),
      });
    }
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
    const trigger = page.locator(".chat-pane__nav-toggle").first();
    const readFocusLocation = () =>
      page.evaluate(() => {
        // Native dialog tab order may hand focus to browser chrome when no document candidate remains.
        // `document.hasFocus()` distinguishes that from focus on the underlying inert page.
        if (!document.hasFocus()) {
          return "browser-chrome";
        }
        return document.activeElement?.closest(".shell-nav") ? "navigation" : "page";
      });

    await expect.poll(() => navigation.getAttribute("inert")).toBe("");
    await expect.poll(() => page.locator(".shell-nav-backdrop").count()).toBe(1);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".shell-nav") !== null))
      .toBe(false);

    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Expand sidebar");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect.poll(readFocusLocation).toBe("navigation");

    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".shell-nav-backdrop").getAttribute("aria-hidden"))
      .toBe("true");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Collapse sidebar");

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
    // These shared ownerless fixtures are deliberately outside the human Mine scope.
    await navigation
      .locator(".sidebar-navigation-scope")
      .getByRole("button", { name: "All", exact: true })
      .click();
    const row = navigation.locator(".sidebar-recent-session").first();
    await row.hover();
    await row.click({ button: "right" });
    const sessionMenu = page.getByRole("menu", { name: /Actions for/ });
    await expect.poll(() => sessionMenu.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => sessionMenu.count()).toBe(0);
    await expect.poll(() => dialog.isVisible()).toBe(true);

    const pageDetails = page.locator(".chat-controls__model-picker").first();
    await pageDetails.evaluate((element) => ((element as HTMLDetailsElement).open = true));
    await expect.poll(() => pageDetails.getAttribute("open")).toBe("");
    await page.keyboard.press("Escape");
    await expect.poll(() => pageDetails.getAttribute("open")).toBe("");
    await expect.poll(() => dialog.isVisible()).toBe(false);

    await trigger.click();
    await expect.poll(() => dialog.isVisible()).toBe(true);

    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-drawer-open");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => trigger.getAttribute("aria-label")).toBe("Expand sidebar");
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await trigger.click();
    const inbox = navigation.locator(".sidebar-issues-button");
    await inbox.click();
    const attentionDialog = page.getByRole("dialog", { name: "Inbox" });
    await attentionDialog.waitFor();
    await expect.poll(() => attentionDialog.getAttribute("aria-modal")).toBe("true");
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
    await expect.poll(() => attentionDialog.count()).toBe(0);
    await expect.poll(() => dialog.isVisible()).toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:debug-overlay-request"));
    });
    const debugOverlay = page.locator(".debug-overlay");
    await debugOverlay.waitFor();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(() => debugOverlay.count()).toBe(0);

    await trigger.click();
    await page.mouse.click(899, 450);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await trigger.click();
    await navigation.locator(".sidebar-issues-button").click();
    await attentionDialog.waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => attentionDialog.count()).toBe(0);
    await expect.poll(() => navigation.getAttribute("inert")).toBeNull();
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
      await page.locator(".chat-pane__nav-toggle").first().click();
      await expect.poll(() => dialog.isVisible()).toBe(true);

      const catalog = drawer.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      await catalog.locator(".sidebar-recent-sessions__head").hover();
      await catalog.locator('[data-session-catalog-view-menu="codex"]').click();
      await page
        .locator('wa-dropdown-item[value="hide-catalog"]')
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
      expect(drawerToastGeometry.placement).toBe("overlay");
      expect(drawerToastGeometry.computedTop).toBe(20);
      const dismiss = toast.getByRole("button", { name: "Dismiss" });
      await dismiss.click({ trial: true });

      await page.screenshot({
        animations: "disabled",
        path: path.join(TOAST_PROOF_DIR, `mobile-drawer-toast-${colorScheme}.png`),
      });
      if (finalLayout === "compact") {
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.isVisible()).toBe(false);
      } else {
        await page.setViewportSize(finalViewport);
        await expect.poll(() => drawer.count()).toBe(0);
      }
      expect(page.viewportSize()).toEqual(finalViewport);
      const retainedHost = page.locator(".shell > openclaw-toast-host");
      await expect.poll(() => retainedHost.getAttribute("data-toast-placement")).toBe("shell");
      const retainedToast = retainedHost.locator(".app-toast");
      await expect.poll(() => retainedToast.textContent()).toContain("Codex hidden");
      await expect
        .poll(async () => {
          const [toastBounds, headerBounds] = await Promise.all([
            retainedToast.boundingBox(),
            page.locator(".chat-pane__header:visible").first().boundingBox(),
          ]);
          return Boolean(
            toastBounds && headerBounds && toastBounds.y >= headerBounds.y + headerBounds.height,
          );
        })
        .toBe(true);
      await expect
        .poll(async () => {
          const [toastBounds, composerBounds] = await Promise.all([
            retainedToast.boundingBox(),
            page.locator(".agent-chat__composer-shell").boundingBox(),
          ]);
          return Boolean(
            toastBounds && composerBounds && toastBounds.y + toastBounds.height < composerBounds.y,
          );
        })
        .toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(TOAST_PROOF_DIR, `handed-off-toast-${finalLayout}-${colorScheme}.png`),
      });
      await retainedToast.getByRole("button", { name: "Dismiss" }).click();
      await expect.poll(() => retainedToast.isVisible()).toBe(false);
    },
  );

  it("keeps the sidebar rail beside a half-width native link browser", async () => {
    const page = await openPage({ webChrome: true, width: 620 });
    await expect.poll(() => page.locator(".macos-titlebar-controls").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".sidebar-resizer").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".shell-nav").isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(false);

    await page.setViewportSize({ width: 560, height: 900 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await page.setViewportSize({ width: 620, height: 900 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".shell-nav").isVisible()).toBe(true);
  });

  it("uses the drawer below the native minimum main-pane width", async () => {
    const page = await openPage({ webChrome: true, width: 560 });
    await expect.poll(() => page.locator(".macos-titlebar-controls").isVisible()).toBe(false);
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(true);
    // The native traffic-light cluster ends around x=78. Keep the brand aligned
    // with the desktop titlebar controls' 92px inset so the groups stay distinct.
    await expect
      .poll(() =>
        page.locator(".topbar-brand").evaluate((element) => element.getBoundingClientRect().x),
      )
      .toBe(92);
  });

  it("hides the drawer hamburger at narrow widths when the native toggle is present", async () => {
    const page = await openPage({ nativeNav: true, width: 900 });
    // The native titlebar toggle drives the drawer via the window event, so
    // the web hamburger would be a duplicate control.
    await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(false);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    // Closing through the native toggle restores focus to the content anchor,
    // not the hidden hamburger the drawer recorded as its trigger.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
    });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .not.toContain("shell--nav-drawer-open");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("content")))
      .toBe(true);
  });
});
