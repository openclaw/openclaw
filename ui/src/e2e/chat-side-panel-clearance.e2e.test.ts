import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  activateChatHeaderPanelAction,
  failNextDeviceIdentityMint,
  focusChatSidePanel,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat side-panel shell clearance",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:side-panel-clearance";
const proofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let proofDir: string | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("chat-side-panel-clearance", proofDirParent)
    : undefined;
});
const limitedScopes = ["operator.read", "operator.write"];
const historyMessages = [
  {
    id: "side-panel-clearance-user",
    role: "user",
    content: [{ type: "text", text: "Keep the panel header controls reachable." }],
    timestamp: Date.now() - 60_000,
  },
  {
    id: "side-panel-clearance-assistant",
    role: "assistant",
    content: [{ type: "text", text: "The panel header now clears every shell control." }],
    timestamp: Date.now(),
  },
];

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
    historyMessages,
    methodResponses: {
      "sessions.files.list": {
        browser: {
          path: "ui/src/pages/chat",
          entries: [
            {
              kind: "file",
              name: "chat-pane-render.ts",
              path: "ui/src/pages/chat/chat-pane-render.ts",
            },
            { kind: "file", name: "sidebar.css", path: "ui/src/styles/chat/sidebar.css" },
          ],
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "chat-pane-render.ts",
            path: "/workspace/openclaw/ui/src/pages/chat/chat-pane-render.ts",
            size: 18_432,
          },
          {
            kind: "read",
            missing: false,
            name: "sidebar.css",
            path: "/workspace/openclaw/ui/src/styles/chat/sidebar.css",
            size: 24_820,
          },
        ],
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
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, seededSessionKey, seededThemeMode }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode: seededThemeMode,
          sidebarSessionLayouts: {
            [seededSessionKey]: { columns: [], open: false, expanded: false },
          },
        }),
      );
    },
    { key: settingsKey, seededSessionKey: sessionKey, seededThemeMode: themeMode },
  );
}

async function openExpandedFilesPanel(page: Page, beforeExpandProof?: string): Promise<void> {
  await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
  await page.locator(".chat-group").first().waitFor();
  await activateChatHeaderPanelAction(page, "Show session files");
  if (beforeExpandProof) {
    await capturePanel(page, beforeExpandProof);
  }
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

async function expectPanelHeaderControlsClearShellChrome(
  page: Page,
  shellChromeExpected: boolean,
): Promise<void> {
  const panelControls = page.locator(".chat-pane__actions button:visible");
  const panelCount = await panelControls.count();
  expect(panelCount).toBeGreaterThan(0);

  const geometry = await page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
    };
    const header = document.querySelector(".chat-pane__header");
    if (!header) {
      throw new Error("Focused main panel has no task toolbar");
    }
    const headerRect = rect(header);
    const headerStyle = getComputedStyle(header);
    const panels = [...document.querySelectorAll(".chat-pane__actions button:not([hidden])")]
      .map(rect)
      .filter((button) => button.bottom > button.top && button.right > button.left);
    const shells = [
      ...document.querySelectorAll(
        ":is(.shell-chrome-controls, .macos-titlebar-controls, .sidebar-attention--floating) button:not([hidden])",
      ),
    ]
      .map(rect)
      .filter((shell) => shell.bottom > shell.top && shell.right > shell.left);
    return {
      contentLeft: headerRect.left + Number.parseFloat(headerStyle.paddingLeft),
      contentRight: headerRect.right - Number.parseFloat(headerStyle.paddingRight),
      panels,
      shells,
    };
  });

  if (shellChromeExpected) {
    expect(geometry.shells.length).toBeGreaterThan(0);
  } else {
    expect(geometry.shells).toEqual([]);
  }
  for (const panel of geometry.panels) {
    for (const shell of geometry.shells) {
      expect(
        panel.left >= shell.right + 4 ||
          panel.right <= shell.left - 4 ||
          panel.top >= shell.bottom + 4 ||
          panel.bottom <= shell.top - 4,
      ).toBe(true);
    }
  }
  expect(
    geometry.panels.every(
      (box) => box.left >= geometry.contentLeft - 0.5 && box.right <= geometry.contentRight + 0.5,
    ),
  ).toBe(true);
  for (let index = 0; index < panelCount; index += 1) {
    await panelControls.nth(index).click({ trial: true });
  }
}

async function capturePanel(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(proofDir, `${name}.png`) });
}

suite.define(() => {
  it.each([844, 640])(
    "keeps the mobile empty panel picker below the composer at height %s",
    async (height) => {
      await suite.withPage(
        {
          viewport: { width: 390, height },
          hasTouch: true,
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
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
          const bottomGap = () =>
            shell.evaluate((element) => getComputedStyle(element).marginBottom);
          for (const safeArea of [0, 24]) {
            await page.evaluate((inset) => {
              document.documentElement.style.setProperty("--safe-area-bottom", `${inset}px`);
            }, safeArea);
            expect(await bottomGap()).toBe(`${6 + safeArea}px`);
            await textarea.focus();
            expect(await bottomGap()).toBe(`${6 + safeArea}px`);
            await textarea.blur();
          }
          await page.evaluate(() =>
            document.documentElement.style.removeProperty("--safe-area-bottom"),
          );
          await capturePanel(page, "mobile-composer-spacing");
          await page.locator(".chat-side-panel-toggle").click();
          const picker = page.locator(".side-panel-empty--selector");
          await picker.waitFor();
          await waitForShellLayout(page);
          await capturePanel(page, "mobile-empty-panel");
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
          expect(await choices.count()).toBeGreaterThan(5);
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
          await capturePanel(page, "mobile-empty-panel-scrolled");
          await choices.filter({ hasText: "Files" }).click();
          await page.locator('.side-panel__panel[data-panel-slot="workspace"]:visible').waitFor();
          await page.locator(".chat-side-panel-toggle").click();
          await expect.poll(() => picker.isVisible()).toBe(false);
        },
      );
    },
  );

  it.each(["ltr", "rtl"] as const)(
    "keeps session Actions clickable beside an attachment in %s",
    async (direction) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1416, height: 707 } },
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
      );
    },
  );

  it("keeps the page title centered beside the collapsed-navigation controls", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
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
        // The toolbar row sits at the top of the content column in both states.
        await expect.poll(rowCenter).toBe(24);
        await capturePanel(page, "page-toolbar-expanded");

        await page.locator(".sidebar-brand__collapse").click();
        await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-collapsed");
        await expect.poll(rowCenter).toBe(24);
        const controls = page.locator(".shell-chrome-controls button:visible");
        const controlBoxes = await controls.evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect()),
        );
        expect(controlBoxes.length).toBeGreaterThan(0);
        const tabsBox = (await tabs.boundingBox())!;
        for (const box of controlBoxes) {
          expect(box.top + box.height / 2).toBe(24);
          expect(box.right).toBeLessThan(tabsBox.x);
        }
        await capturePanel(page, "page-toolbar-collapsed");
      },
    );
  });

  it.each([
    {
      beforeExpandProof: "right-docked",
      home: false,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".sidebar-brand__search",
      name: "expanded navigation",
      navCollapsed: false,
      operatorScopes: undefined,
      proof: "expanded-nav",
      themeMode: "dark" as const,
    },
    {
      beforeExpandProof: undefined,
      home: false,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".shell-chrome-controls__search",
      name: "collapsed navigation",
      navCollapsed: true,
      operatorScopes: undefined,
      proof: "collapsed-nav",
      themeMode: "dark" as const,
    },
    {
      beforeExpandProof: undefined,
      home: true,
      deviceLess: false,
      direction: "ltr",
      expectedControl: ".shell-chrome-controls__home",
      name: "collapsed navigation with Home and attention",
      navCollapsed: true,
      operatorScopes: undefined,
      proof: "collapsed-nav-home-attention",
      themeMode: "dark" as const,
    },
    {
      beforeExpandProof: undefined,
      home: false,
      deviceLess: true,
      direction: "rtl",
      expectedControl: ".sidebar-attention--floating .sidebar-issues-button",
      name: "collapsed RTL limited-access status and attention",
      navCollapsed: true,
      operatorScopes: limitedScopes,
      proof: "collapsed-rtl-limited-attention",
      themeMode: "dark" as const,
    },
  ])("keeps focused main controls clear of shell chrome for $name", async (testCase) => {
    await suite.withPage(
      {
        colorScheme: testCase.themeMode,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1600 },
      },
      async ({ page }) => {
        if (testCase.deviceLess) {
          await failNextDeviceIdentityMint(page);
        }
        await seedSettings(page, testCase.themeMode);
        await installMockGateway(
          page,
          scenario({
            home: testCase.home,
            operatorScopes: testCase.operatorScopes,
          }),
        );
        await openExpandedFilesPanel(page, testCase.beforeExpandProof);
        await page.evaluate((direction) => {
          document.documentElement.dir = direction;
        }, testCase.direction);
        if (testCase.navCollapsed) {
          await page.locator(".sidebar-brand__collapse").click();
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .toContain("shell--nav-collapsed");
          await page.locator(".sidebar-attention--floating .sidebar-issues-button").waitFor();
        }
        await page.locator(testCase.expectedControl).waitFor();
        await waitForShellLayout(page);
        await expectPanelHeaderControlsClearShellChrome(page, testCase.navCollapsed);
        await capturePanel(page, testCase.proof);
      },
    );
  });
});
