import type { Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { polledAttribute } from "./chat-presentation.test-support.ts";
import {
  activateChatHeaderPanelAction,
  failNextDeviceIdentityMint,
  focusChatSidePanel,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { setupPages } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat side-panel shell clearance",
  startServerBeforeBrowser: true,
});
const withPage = setupPages(suite, () => ({ locale: "en-US", serviceWorkers: "block" }));

const sessionKey = "agent:main:side-panel-clearance";
const limitedScopes = ["operator.read", "operator.write"];

function scenario(
  options: {
    home?: boolean;
    operatorScopes?: string[];
  } = {},
): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "device.scopes.requestUpgrade",
      "device.scopes.waitUpgrade",
      ...(options.home ? ["chat.history", "chat.send"] : []),
    ],
    historyMessages: [{ role: "assistant", content: "Keep the panel header controls reachable." }],
    methodResponses: {
      "sessions.files.list": {
        browser: { path: "ui/src/pages/chat", entries: [] },
        files: [],
        root: "/workspace/openclaw",
        sessionKey,
      },
    },
    ...(options.operatorScopes ? { operatorScopes: options.operatorScopes } : {}),
    sessionKey,
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  };
}

async function seedSettings(page: Page, themeMode: "light" | "dark") {
  await seedChatSettings(page, suite.server.baseUrl, {
    theme: "claw",
    themeMode,
    sidebarSessionLayouts: { [sessionKey]: { columns: [], open: false, expanded: false } },
  });
}

async function openExpandedFilesPanel(page: Page): Promise<void> {
  await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
  await page.locator(".chat-group").first().waitFor();
  await activateChatHeaderPanelAction(page, "Show session files");
  await focusChatSidePanel(page);
}

async function waitForShellLayout(page: Page): Promise<void> {
  await page.locator(".shell").evaluate(async (shell) => {
    const finiteAnimations = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finiteAnimations.map((animation) => animation.finished));
  });
}

async function expectPanelHeaderControlsClearShellChrome(page: Page): Promise<void> {
  const panelControls = page.locator('[data-region-header="side"] button:visible');
  const panelCount = await panelControls.count();
  expect(panelCount).toBeGreaterThan(0);

  expect(
    await page.evaluate(() => {
      const visibleRects = (selector: string) =>
        [...document.querySelectorAll(selector)]
          .map((element) => element.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
      const header = document.querySelector('[data-region-header="side"]')!;
      const headerRect = header.getBoundingClientRect();
      const headerStyle = getComputedStyle(header);
      const panels = visibleRects('[data-region-header="side"] button:not([hidden])');
      const shells = visibleRects(
        ":is(.shell-chrome-controls, .macos-titlebar-controls, .sidebar-rail, .sidebar-session-toolbar) button:not([hidden])",
      );
      const left = headerRect.left + Number.parseFloat(headerStyle.paddingLeft);
      const right = headerRect.right - Number.parseFloat(headerStyle.paddingRight);
      return {
        hasShellControls: shells.length > 0,
        contained: panels.every((box) => box.left >= left - 0.5 && box.right <= right + 0.5),
        clear: panels.every((panel) =>
          shells.every(
            (shell) =>
              panel.left >= shell.right + 4 ||
              panel.right <= shell.left - 4 ||
              panel.top >= shell.bottom + 4 ||
              panel.bottom <= shell.top - 4,
          ),
        ),
      };
    }),
  ).toEqual({ hasShellControls: true, contained: true, clear: true });
  for (let index = 0; index < panelCount; index += 1) {
    await panelControls.nth(index).click({ trial: true });
  }
}

suite.define(() => {
  it.each([844, 640])(
    "keeps the mobile empty panel picker below the composer at height %s",
    async (height) => {
      await withPage(
        async ({ page, context }) => {
          await seedSettings(page, "light");
          await installMockGateway(page, {
            ...scenario(),
            featureMethods: [...defaultControlUiFeatureMethods, "browser.request", "terminal.open"],
            terminalEnabled: true,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.locator(".chat-group").first().waitFor();
          const composer = page.locator(".agent-chat__input");
          await composer.waitFor();
          const shell = page.locator(".agent-chat__composer-shell");
          const textarea = composer.locator("textarea");
          const protocol = await context.newCDPSession(page);
          const bottomGap = () =>
            shell.evaluate(
              (element) => window.innerHeight - element.getBoundingClientRect().bottom,
            );
          for (const safeArea of [0, 24]) {
            await protocol.send("Emulation.setSafeAreaInsetsOverride", {
              insets: { bottom: safeArea },
            });
            expect(await bottomGap()).toBe(6 + safeArea);
            await textarea.focus();
            expect(await bottomGap()).toBe(6 + safeArea);
            await textarea.blur();
          }
          await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 0 } });
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          const picker = page.locator(".side-panel-empty--selector");
          await picker.waitFor();
          await waitForShellLayout(page);
          const geometry = await picker.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const body = element.closest(".side-panel__empty-body")!.getBoundingClientRect();
            const first = element.querySelector("button")!.getBoundingClientRect();
            const composerBounds = document
              .querySelector(".agent-chat__input")!
              .getBoundingClientRect();
            return {
              pickerTop: bounds.top,
              panelTop: body.top,
              firstTop: first.top,
              composerBottom: composerBounds.bottom,
            };
          });
          expect(geometry.pickerTop).toBeGreaterThanOrEqual(geometry.panelTop);
          expect(geometry.firstTop).toBeGreaterThanOrEqual(geometry.composerBottom);
          const choices = picker.locator("button");
          expect(await picker.locator(".side-panel-type-option__label").allTextContents()).toEqual([
            "Subagents",
            "Processes",
            "Review",
            "Terminal",
            "Browser",
            "Files",
            "Side chat",
          ]);
          for (const choice of [choices.first(), choices.last()]) {
            await choice.scrollIntoViewIfNeeded();
            await choice.click({ trial: true });
            const contained = await choice.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const body = button.closest(".side-panel__empty-body")!.getBoundingClientRect();
              return box.top >= body.top && box.bottom <= body.bottom;
            });
            expect(contained).toBe(true);
          }
          await choices.filter({ hasText: "Files" }).click();
          await page.locator('.side-panel__panel[data-panel-slot="workspace"]:visible').waitFor();
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await expect.poll(() => picker.isVisible()).toBe(false);
        },
        { viewport: { width: 390, height }, hasTouch: true },
      );
    },
  );

  it.each(["ltr", "rtl"] as const)(
    "keeps session Actions clickable beside an attachment in %s",
    async (direction) => {
      await withPage(
        async ({ page }) => {
          const title = "QA worktree attachment delivery";
          const filename = "worktree-report.txt";
          const mediaUrl = `/__openclaw__/assistant-media?source=${filename}&mediaTicket=fixture`;
          await page.route("**/__openclaw__/assistant-media?**", (route) =>
            route.fulfill({ contentType: "text/plain", body: "WORKTREE_ATTACHMENT\n" }),
          );
          await seedSettings(page, "dark");
          await installMockGateway(page, {
            ...scenario(),
            featureMethods: [...defaultControlUiFeatureMethods, "browser.request", "terminal.open"],
            terminalEnabled: true,
            methodResponses: {
              ...scenario().methodResponses,
              "session.members.listEvidence": {
                sessionKey,
                members: [],
                identities: [],
                role: "owner",
                allowedVisibilities: ["shared", "draft"],
              },
            },
            workspace: "/workspace/worktree-attachment-fixture",
            sessions: [
              { key: "agent:main:main", displayName: "Main Session", kind: "direct" },
              {
                key: sessionKey,
                displayName: title,
                kind: "direct",
                parentSessionKey: "agent:main:main",
                sharingRole: "owner",
                visibility: "shared",
              },
            ],
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "attachment",
                    attachment: {
                      kind: "document",
                      label: filename,
                      mimeType: "text/plain",
                      url: mediaUrl,
                    },
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.evaluate((value) => {
            document.documentElement.dir = value;
          }, direction);
          await page
            .getByRole("button", { name: `Open ${filename} in the side panel`, exact: true })
            .click();
          await page.locator("openclaw-chat-detail-panel:visible pre").waitFor();
          await waitForShellLayout(page);
          const actions = page.getByRole("button", { name: `Actions for ${title}`, exact: true });
          const expectActionsReachable = async () => {
            const geometry = await actions.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const header = button.closest(".chat-pane__header")!.getBoundingClientRect();
              const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return {
                contained: box.left >= header.left && box.right <= header.right,
                reachable: hit === button || button.contains(hit),
              };
            });
            expect(geometry).toEqual({ contained: true, reachable: true });
            await actions.click();
            await expect.poll(() => actions.getAttribute("aria-expanded")).toBe("true");
            await page.keyboard.press("Escape");
            await expect.poll(() => actions.getAttribute("aria-expanded")).toBe("false");
          };
          await expectActionsReachable();
          if (direction === "ltr") {
            const divider = page.getByRole("separator", { name: "Resize side panel", exact: true });
            const before = await divider.boundingBox();
            if (!before) {
              throw new Error("The attachment panel has no resize handle");
            }
            const centerX = before.x + before.width / 2;
            const centerY = before.y + before.height / 2;
            await page.mouse.move(centerX, centerY);
            await page.mouse.down();
            await page.mouse.move(centerX - 80, centerY, { steps: 4 });
            await page.mouse.up();
            await expect
              .poll(async () => (await divider.boundingBox())!.x)
              .toBeLessThan(before.x - 50);
            await expectActionsReachable();
          }
        },
        { viewport: { width: 1416, height: 707 } },
      );
    },
  );

  it("keeps stacked page tabs clear of the collapsed navigation rail", async () => {
    await withPage(
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}sessions`);

        const shell = page.locator(".shell");
        const header = page.locator(".content:not(.content--chat) .content-header").first();
        const tabs = header.locator(".hub-page-header__tabs");
        await tabs.waitFor();
        const rowCenter = async () => {
          const box = await tabs.boundingBox();
          return box ? box.y + box.height / 2 : -1;
        };
        const expandedCenter = await rowCenter();
        expect(expandedCenter).toBeGreaterThan(24);

        await page.locator('[data-navigation-view][aria-pressed="true"]').click();
        await polledAttribute(shell, "class").toContain("shell--nav-collapsed");
        await expect.poll(rowCenter).toBeGreaterThanOrEqual(expandedCenter);
        const controls = page.locator(".sidebar-rail [data-navigation-view]");
        const controlBoxes = await controls.evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect()),
        );
        expect(controlBoxes).toHaveLength(3);
        const tabsBox = (await tabs.boundingBox())!;
        for (const box of controlBoxes) {
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
          expect(box.right).toBeLessThan(tabsBox.x);
        }
        for (let index = 0; index < controlBoxes.length; index += 1) {
          await controls.nth(index).click({ trial: true });
        }
      },
      { viewport: { height: 900, width: 1600 } },
    );
  });

  it.each([
    ["expanded navigation", false, false, false],
    ["collapsed navigation", true, false, false],
    ["collapsed navigation with Home and attention", true, true, false],
    ["collapsed RTL limited-access status and attention", true, false, true],
  ] as const)(
    "keeps focused main controls clear of shell chrome for %s",
    async (_name, navCollapsed, home, deviceLess) => {
      await withPage(
        async ({ page }) => {
          if (deviceLess) {
            await failNextDeviceIdentityMint(page);
          }
          await seedSettings(page, "dark");
          await installMockGateway(
            page,
            scenario({
              home,
              operatorScopes: deviceLess ? limitedScopes : undefined,
            }),
          );
          await openExpandedFilesPanel(page);
          await page.evaluate(
            (direction) => {
              document.documentElement.dir = direction;
            },
            deviceLess ? "rtl" : "ltr",
          );
          if (navCollapsed) {
            await page.locator('[data-navigation-view][aria-pressed="true"]').click();
            await polledAttribute(page.locator(".shell"), "class").toContain(
              "shell--nav-collapsed",
            );
            await page.locator(".sidebar-rail__bottom .sidebar-issues-button").waitFor();
          }
          const expectedControl = home
            ? ".sidebar-rail__bottom .sidebar-footer-bar__home"
            : deviceLess
              ? ".sidebar-rail__bottom .sidebar-issues-button"
              : ".sidebar-brand__search";
          await page.locator(expectedControl).waitFor();
          await waitForShellLayout(page);
          await expectPanelHeaderControlsClearShellChrome(page);
        },
        { colorScheme: "dark", viewport: { height: 900, width: 1600 } },
      );
    },
  );
});
