import { Buffer } from "node:buffer";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { nextPaint, singleFileDiff } from "./chat-session-diff.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  readColdOpenOutcome,
  seedMainCompanionLayout,
  type ColdOpenOutcome,
} from "./chat-sidebar-panel-contract.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  RETAINED_DESKTOP_SESSION_KEY,
  retainedDesktopEnvironment,
  retainedDesktopScenario,
} from "./desktop-retention.test-support.ts";
import {
  createRfbRawFrame,
  installDesktopClientFake,
  installScriptedRfbServer,
} from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat sidebar cold-open invariant",
  startServerBeforeBrowser: true,
});

const HIDDEN_BOARD_SESSION_KEY = "agent:main:hidden-board-slot";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
  "base64",
);

const offeredSlotLabels = [
  "Side chat",
  "Files",
  "Browser",
  "Review",
  "Subagents",
  "Processes",
  "Terminal",
  "Desktop",
  "Discussion",
] as const;

type OfferedSlotLabel = (typeof offeredSlotLabels)[number];

const browserTabs = (
  running: boolean,
  tabs: { targetId: string; tabId: string; title: string; url: string }[] = [],
) => ({
  match: { method: "GET", path: "/tabs" },
  response: { running, tabs },
});
const browserScreenshot = (targetId: string, url: string, screenshotPath: string) => ({
  match: { method: "POST", path: "/screenshot" },
  response: { path: screenshotPath, targetId, url },
});
const populatedBrowser = (id: string, title: string, url: string) => [
  browserTabs(true, [{ targetId: `${id}-target`, tabId: `${id}-tab`, title, url }]),
  browserScreenshot(`${id}-target`, url, `/proof/${id}.png`),
];
const mediaRoute = (page: Page) =>
  page.route("**/__openclaw__/assistant-media?*", (route) =>
    route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png" }),
  );
const INVENTORY = "environments.status";
const OBSERVE = "desktop.observe";
const requestCount = (gateway: Awaited<ReturnType<typeof installMockGateway>>, method: string) =>
  expect.poll(async () => (await gateway.getRequests(method)).length);

function coldOpenScenario(populated = false): ControlUiMockGatewayScenario {
  const rows = <T>(...values: T[]) => (populated ? values : []);
  const root = populated ? "/tmp/checkout" : "/tmp/plain-workspace";
  const files = rows({
    kind: "modified",
    missing: false,
    name: "README.md",
    path: "/tmp/checkout/README.md",
    size: 128,
  });
  return {
    featureMethods: [
      "browser.request",
      "chat.metadata",
      "chat.startup",
      OBSERVE,
      "environments.list",
      INVENTORY,
      "session.discussion.info",
      "session.discussion.open",
      "sessions.companion.state",
      "sessions.diff",
      "sessions.files.list",
      "terminal.open",
    ],
    ...(populated
      ? {
          sessions: [
            {
              key: "agent:main:main",
              sessionId: "main-session",
              kind: "direct",
              label: "Main",
              updatedAt: 1,
              totalTokens: 2000,
              totalTokensFresh: true,
              contextTokens: 100000,
            },
            {
              key: "agent:main:subagent:panel-content",
              kind: "direct",
              label: "Check panel content",
              spawnedBy: "agent:main:main",
              status: "done",
              updatedAt: 2,
            },
          ],
        }
      : {}),
    methodResponses: {
      "sessions.processes.list": {
        sessionId: "main-session",
        truncated: false,
        processes: rows({
          processId: "process-1",
          instanceId: "incarnation-1",
          name: "Build application",
          status: "running",
          startedAt: 1,
          tail: "Compiling",
          truncated: false,
          canStop: false,
        }),
      },
      "browser.request": {
        cases: populated
          ? populatedBrowser("browser", "OpenClaw", "https://example.test/")
          : [browserTabs(false)],
      },
      "environments.list": {
        environments: rows({
          id: "worker-desktop-1",
          type: "worker",
          status: "available",
          desktop: true,
        }),
      },
      "session.discussion.info": {
        state: "open",
        ...(populated
          ? {
              embedUrl: "https://discussion.example/embed/thread/session",
              openUrl: "https://discussion.example/session",
            }
          : {}),
      },
      ...(populated
        ? {
            "sessions.companion.state": {
              exchanges: [
                {
                  question: "What changed?",
                  answer: "Every offered panel now opens with useful content.",
                  ts: Date.now() - 1_000,
                },
              ],
            },
            "sessions.diff": singleFileDiff(
              "README.md",
              "@@ -1 +1,2 @@\n OpenClaw\n+Cold-open invariant",
              1,
              0,
              { root },
            ),
          }
        : {}),
      "sessions.files.list": {
        browser: {
          entries: rows({ kind: "file", name: "README.md", path: "README.md" }),
          path: "",
        },
        files,
        gitCheckout: populated,
        root,
        sessionKey: "main",
      },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: root,
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    terminalEnabled: true,
    workspace: root,
    workspaceGit: populated,
  };
}

async function openColdSidebar(page: Page, scenario = coldOpenScenario()) {
  await mediaRoute(page);
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
  await gateway.waitForRequest("session.discussion.info");
  await gateway.waitForRequest("sessions.companion.state");
  expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  await selectChatLayoutAction(page, "Side panel");
  const choices = page.locator(".side-panel-launcher").getByRole("button");
  await choices.first().waitFor();
  expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  return choices;
}

async function seedSidebar(
  page: Page,
  sessionKey: string,
  panels: string[],
  activePanelId: string,
  mainPanelId?: string,
) {
  const layout = {
    columns: [
      {
        id: "side-panel-column",
        side: "right",
        panels: panels.map((slot) => ({ id: slot, slot })),
        activePanelId,
        height: 360,
        width: 480,
      },
    ],
    ...(mainPanelId ? { mainPanelId } : {}),
    dock: "right",
    open: true,
    expanded: false,
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    value: JSON.stringify({ sessionKey, sidebarSessionLayouts: { [sessionKey]: layout } }),
  });
}
const seedHiddenBoardSlot = (page: Page) =>
  seedSidebar(page, HIDDEN_BOARD_SESSION_KEY, ["dashboard"], "dashboard");
async function seedRetainedDesktopSlot(
  page: Page,
  activePanel: "workspace" | "conversation" = "workspace",
) {
  const conversation = activePanel === "conversation";
  await seedSidebar(
    page,
    RETAINED_DESKTOP_SESSION_KEY,
    ["workspace", ...(conversation ? ["conversation"] : []), "desktop"],
    activePanel,
    conversation ? "workspace" : undefined,
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "openclaw.desktopPanel",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
  });
}

async function openRetainedDesktop(
  page: Page,
  activePanel: "workspace" | "conversation" = "workspace",
) {
  await seedRetainedDesktopSlot(page, activePanel);
  const gateway = await installMockGateway(page, retainedDesktopScenario(coldOpenScenario()));
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, RETAINED_DESKTOP_SESSION_KEY));
  await waitForControlUiGatewayReady(page);
  const desktop = page.locator("openclaw-desktop-panel");
  return { gateway, desktop, canvas: desktop.locator("canvas") };
}

async function clickSidebarTab(page: Page, label: string): Promise<void> {
  await page.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label }).click();
}

async function readSlotColdOpenOutcome(
  label: OfferedSlotLabel,
  scenario: ControlUiMockGatewayScenario,
  expectedOutcome?: ColdOpenOutcome["outcome"],
): Promise<ColdOpenOutcome> {
  const context = await suite.newBrowserContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const choices = await openColdSidebar(page, scenario);
    expect(
      await choices.locator(".side-panel-type-option__label").allTextContents(),
      `${label} cold-open offered slots`,
    ).toEqual(offeredSlotLabels);
    const held =
      label === "Discussion"
        ? await holdModuleResponse(
            page,
            controlUiE2eBuiltModuleRequest(
              "ui/src/pages/chat/components/session-discussion-panel.tsx",
            ),
          )
        : null;
    try {
      await choices.filter({ hasText: label }).click();
      if (held) {
        await held.request;
        expect(await readColdOpenOutcome(page)).toEqual({
          outcome: "loading",
        });
      }
    } finally {
      held?.release();
    }

    if (label === "Processes") {
      const processes = page.locator("openclaw-chat-processes-panel");
      await processes
        .getByText(
          expectedOutcome === "content"
            ? "Build application"
            : "No background processes in this conversation.",
          { exact: true },
        )
        .waitFor();
      if (expectedOutcome !== "content") {
        expect(await processes.getByRole("listitem").count()).toBe(0);
        expect(await processes.getByRole("button", { name: /^Stop/ }).count()).toBe(0);
      }
    }
    if (label === "Subagents") {
      const subagents = page.locator("openclaw-chat-subagents-panel");
      if (expectedOutcome === "content") {
        const row = subagents.locator('[data-session-key="agent:main:subagent:panel-content"]');
        await row.getByText("Check panel content", { exact: true }).waitFor();
        expect(await row.getByRole("button", { name: /^Check panel content/ }).isEnabled()).toBe(
          true,
        );
      } else {
        await subagents.getByText("No subagents in this conversation.", { exact: true }).waitFor();
      }
    }
    if (label === "Side chat" && !expectedOutcome) {
      const companion = page.locator("openclaw-chat-session-rail");
      await companion
        .getByRole("textbox", { name: "Ask in side chat", exact: true })
        .fill("What changed?");
      expect(await companion.getByRole("button", { name: "Ask", exact: true }).isEnabled()).toBe(
        true,
      );
    }
    if (expectedOutcome) {
      await expect
        .poll(() => readColdOpenOutcome(page), { message: `${label} cold-open outcome` })
        .toMatchObject({ outcome: expectedOutcome });
    } else {
      await expect
        .poll(() => readColdOpenOutcome(page), { message: `${label} finished cold-open` })
        .not.toMatchObject({ outcome: "loading" });
    }
    return await readColdOpenOutcome(page);
  } finally {
    await suite.closeBrowserContext(context);
  }
}

suite.define(() => {
  it("closes a projected-empty side panel when a hidden board tab remains persisted", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await seedHiddenBoardSlot(page);
      await installMockGateway(page, {
        ...coldOpenScenario(),
        sessionKey: HIDDEN_BOARD_SESSION_KEY,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, HIDDEN_BOARD_SESSION_KEY));
      await waitForControlUiGatewayReady(page);

      const panel = page.locator(".sidebar-region__right-runtime .side-panel");
      const selector = panel.locator(".side-panel-launcher");
      await selectChatLayoutAction(page, "Side panel");
      await selector.waitFor();
      expect(await panel.locator(".tabstrip-tab").count()).toBe(0);

      await selectChatLayoutAction(page, "Minimize side panel");
      await selector.waitFor({ state: "hidden" });
    });
  });

  it("refreshes retained Browser state when its sidebar tab becomes active", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await mediaRoute(page);
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request", "chat.metadata", "chat.startup"],
        methodResponses: {
          "browser.request": {
            cases: [browserTabs(true)],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await openChatSidePanelType(page, "Browser");
      const browser = page.locator("openclaw-browser-panel");
      await browser.locator("openclaw-panel-empty-state").waitFor();

      const initialRequests = await gateway.getRequests("browser.request");
      expect(initialRequests.map((request) => request.params)).toEqual([
        {
          method: "GET",
          path: "/tabs",
          tabScope: { sessionKey: "agent:main:main", referencedTabs: [] },
        },
      ]);

      await openChatSidePanelType(page, "Files");
      expect(await browser.evaluate((element) => element.isConnected)).toBe(true);
      const hiddenRequestCount = (await gateway.getRequests("browser.request")).length;
      await gateway.setMethodResponse("browser.request", {
        cases: populatedBrowser("blacksmith", "Blacksmith", "https://blacksmith.sh/"),
      });
      await nextPaint(page);
      expect((await gateway.getRequests("browser.request")).length).toBe(hiddenRequestCount);

      await clickSidebarTab(page, "Browser");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("browser.request");
          return requests.filter((request) => {
            const params = request.params as { method?: string; path?: string };
            return params.method === "GET" && params.path === "/tabs";
          }).length;
        })
        .toBe(2);
      await expect
        .poll(async () =>
          (await gateway.getRequests("browser.request")).map((request) => request.params),
        )
        .toContainEqual({
          body: { targetId: "blacksmith-tab", type: "png" },
          method: "POST",
          path: "/screenshot",
          tabScope: { sessionKey: "agent:main:main" },
        });

      await browser.locator(".bp-shot").waitFor();
      expect(await browser.locator(".bp-shot").getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(await browser.locator(".bp-url").inputValue()).toBe("https://blacksmith.sh/");
      expect(await browser.locator(".bp-loading").count()).toBe(0);
    });
  });

  it.each(["inventory", "observation"] as const)(
    "retires hidden Desktop work during %s and starts fresh on reactivation",
    async (phase) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, desktop } = await openRetainedDesktop(page);
        await desktop.waitFor({ state: "attached" });
        await nextPaint(page);
        expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
        for (const method of ["environments.list", INVENTORY, OBSERVE]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
        await installDesktopClientFake(desktop);
        await gateway.deferNext(INVENTORY);
        await clickSidebarTab(page, "Desktop");
        const target = await gateway.waitForRequest(INVENTORY);
        expect(target.params).toEqual({ environmentId: retainedDesktopEnvironment.id });
        const expectLoading = async () => {
          const loading = desktop.getByRole("status").filter({ hasText: "Connecting to desktop…" });
          await loading.getByText("Connecting to desktop…", { exact: true }).waitFor();
          expect(await loading.count()).toBe(1);
          expect(await desktop.locator(".skeleton").count()).toBe(0);
        };
        await expectLoading();
        if (phase === "observation") {
          await gateway.deferNext(OBSERVE);
          await gateway.resolveDeferred(INVENTORY, retainedDesktopEnvironment);
          await gateway.waitForRequest(OBSERVE);
        }
        await clickSidebarTab(page, "Files");
        if (phase === "inventory") {
          await gateway.resolveDeferred(INVENTORY, retainedDesktopEnvironment);
        } else {
          await gateway.resolveDeferred(OBSERVE, {
            transport: "rfb",
            wsPath: "/desktop/observe?token=stale",
            expiresAtMs: 60_000,
            control: false,
          });
        }
        await page.evaluate(() => Promise.resolve());
        expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
        expect(await desktop.getAttribute("data-connect-count")).toBeNull();
        expect(await gateway.getRequests(INVENTORY)).toHaveLength(1);
        expect(await gateway.getRequests(OBSERVE)).toHaveLength(phase === "inventory" ? 0 : 1);
        await clickSidebarTab(page, "Desktop");
        await requestCount(gateway, INVENTORY).toBe(2);
        await expect.poll(() => desktop.getAttribute("data-connect-count")).toBe("1");
        if (phase === "inventory") {
          await expectLoading();
        } else {
          await clickSidebarTab(page, "Files");
          expect(await desktop.evaluate((element) => element.isConnected)).toBe(true);
          expect(await desktop.getAttribute("data-disconnect-count")).toBe("1");
          const observations = (await gateway.getRequests(OBSERVE)).length;
          await clickSidebarTab(page, "Desktop");
          await requestCount(gateway, INVENTORY).toBe(3);
          await expect.poll(() => desktop.getAttribute("data-connect-count")).toBe("2");
          expect(await gateway.getRequests(OBSERVE)).toHaveLength(observations + 1);
          expect(await desktop.getByText("Desktop sources", { exact: true }).count()).toBe(0);
        }
        expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      });
    },
  );

  it("reuses the Desktop connection across quick Chat switches and releases it after 30 seconds", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const artifactDir = createControlUiE2eArtifactDir("desktop-tab-retention");
      await page.clock.install();
      const { gateway, desktop, canvas } = await openRetainedDesktop(page, "conversation");
      const rfb = await installScriptedRfbServer(page);
      await gateway.deferNext(INVENTORY);
      await clickSidebarTab(page, "Desktop");
      await gateway.waitForRequest(INVENTORY);
      await desktop.getByText("Connecting to desktop…", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifactDir, "unified-loading.png") });
      await gateway.resolveDeferred(INVENTORY, retainedDesktopEnvironment);
      await canvas.waitFor({ state: "visible" });
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await rfb.send([createRfbRawFrame()]);
      await expect
        .poll(() =>
          canvas.evaluate((element) =>
            Array.from(
              (element as HTMLCanvasElement).getContext("2d")!.getImageData(4, 4, 1, 1).data,
            ),
          ),
        )
        .toEqual([24, 180, 160, 255]);
      await page.screenshot({ path: path.join(artifactDir, "connected.png") });
      const originalCanvas = await canvas.elementHandle();
      const inventoryCount = (await gateway.getRequests(INVENTORY)).length;
      const observeCount = (await gateway.getRequests(OBSERVE)).length;

      await clickSidebarTab(page, "OpenClaw");
      await canvas.waitFor({ state: "hidden" });
      await page.clock.fastForward(20_000);
      expect(await rfb.events()).toEqual(["authenticated:1"]);
      await clickSidebarTab(page, "Desktop");
      await canvas.waitFor({ state: "visible" });
      expect(
        await canvas.evaluate((element, previous) => element === previous, originalCanvas),
      ).toBe(true);
      expect(await desktop.getByRole("status", { name: "Connecting to desktop…" }).count()).toBe(0);
      expect(await gateway.getRequests(INVENTORY)).toHaveLength(inventoryCount);
      expect(await gateway.getRequests(OBSERVE)).toHaveLength(observeCount);

      // Returning cancels the old deadline; it cannot close a visible desktop later.
      await page.clock.fastForward(30_001);
      expect(await rfb.events()).toEqual(["authenticated:1"]);
      expect(await canvas.isVisible()).toBe(true);
      await clickSidebarTab(page, "OpenClaw");
      await canvas.waitFor({ state: "hidden" });
      await page.clock.fastForward(30_001);
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect(await canvas.count()).toBe(0);
      expect(await gateway.getRequests(OBSERVE)).toHaveLength(observeCount);

      await clickSidebarTab(page, "Desktop");
      await canvas.waitFor({ state: "visible" });
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1", "authenticated:2"]);
      expect(await gateway.getRequests(INVENTORY)).toHaveLength(inventoryCount + 1);
      expect(await gateway.getRequests(OBSERVE)).toHaveLength(observeCount + 1);

      await desktop.getByRole("button", { name: "Desktop actions", exact: true }).click();
      await desktop.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
      await expect.poll(rfb.events).toContain("closed:2");
      await desktop.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
      await clickSidebarTab(page, "OpenClaw");
      await clickSidebarTab(page, "Desktop");
      await desktop.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
      expect(await gateway.getRequests(OBSERVE)).toHaveLength(observeCount + 1);
      expect(await canvas.count()).toBe(0);

      await desktop.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect.poll(rfb.events).toContain("authenticated:3");
      await page.getByRole("button", { name: "Close Desktop", exact: true }).click();
      await expect.poll(rfb.events).toContain("closed:3");
      expect(await canvas.count()).toBe(0);
    });
  });

  it("preserves keyboard state across tab switches and retires an unfinished drag", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
      });
      const { gateway, desktop, canvas } = await openRetainedDesktop(page, "conversation");
      const rfb = await installScriptedRfbServer(page);
      await clickSidebarTab(page, "Desktop");
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await desktop
        .locator(".desktop-connection-rail")
        .getByRole("button", { name: "Take control", exact: true })
        .click();
      await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
      await canvas.click();
      // macOS sends a single state-change keydown when CapsLock is enabled.
      await canvas.dispatchEvent("keydown", { key: "CapsLock", code: "CapsLock" });
      const capsLock = [
        { down: true, keysym: 0xffe5 },
        { down: false, keysym: 0xffe5 },
      ];
      await page.keyboard.down("Shift");
      await page.keyboard.down("ArrowLeft");
      const pressed = [
        { down: true, keysym: 0xffe1 },
        { down: true, keysym: 0xff51 },
      ];
      await expect.poll(rfb.keyEvents).toEqual([...capsLock, ...pressed]);
      await clickSidebarTab(page, "OpenClaw");
      await canvas.waitFor({ state: "hidden" });
      const released = [
        ...capsLock,
        ...pressed,
        ...pressed.map(({ keysym }) => ({ down: false, keysym })),
      ];
      await expect.poll(rfb.keyEvents).toEqual(released);
      await page.keyboard.up("ArrowLeft");
      await page.keyboard.up("Shift");
      await clickSidebarTab(page, "Desktop");
      await canvas.click();
      await page.keyboard.press("x");
      await expect
        .poll(rfb.keyEvents)
        .toEqual([...released, { down: true, keysym: 120 }, { down: false, keysym: 120 }]);
      expect(await gateway.getRequests(OBSERVE)).toHaveLength(2);
      expect(await rfb.events()).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);

      await page.mouse.down();
      await page
        .locator(".side-panel__header .tabstrip-tab")
        .filter({ hasText: "OpenClaw" })
        .press("Enter");
      await expect.poll(rfb.events).toContain("closed:2");
      expect(await canvas.count()).toBe(0);
      await page.mouse.up();
      await clickSidebarTab(page, "Desktop");
      await expect.poll(rfb.events).toContain("authenticated:3");
    });
  });

  it.each([false, true])(
    "keeps a visible Desktop connected when another split pane takes focus (automatic: %s)",
    async (automatic) => {
      const context = await suite.newBrowserContext({
        serviceWorkers: "block",
        viewport: { width: 2200, height: 1000 },
      });
      try {
        const page = await context.newPage();
        await page.clock.install();
        const scenario = retainedDesktopScenario(coldOpenScenario());
        if (automatic) {
          scenario.deferredMethods = [OBSERVE];
        } else {
          await seedRetainedDesktopSlot(page);
        }
        const gateway = await installMockGateway(page, scenario);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, RETAINED_DESKTOP_SESSION_KEY));
        await waitForControlUiGatewayReady(page);
        const rfb = await installScriptedRfbServer(page);
        if (automatic) {
          await gateway.waitForRequest(OBSERVE);
          await gateway.resolveDeferred(OBSERVE);
        } else {
          await clickSidebarTab(page, "Desktop");
        }
        const desktop = page.locator("openclaw-desktop-panel").first();
        await expect.poll(() => rfb.events()).toEqual(["authenticated:1"]);
        await desktop.locator("canvas").waitFor({ state: "visible" });

        await selectChatLayoutAction(page, "Open split view");
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => panes.count()).toBe(2);
        await panes.last().locator(".agent-chat__composer-combobox textarea").click();
        await expect
          .poll(() =>
            panes.evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLElement & { active: boolean }).active),
            ),
          )
          .toEqual([false, true]);
        await nextPaint(page);
        expect(await desktop.locator("canvas").isVisible()).toBe(true);
        expect(await rfb.events()).not.toContain("closed:1");

        const firstCanvas = panes.first().locator("openclaw-desktop-panel canvas");
        await panes.first().locator(".chat-pane__header").click();
        await selectChatLayoutAction(panes.first(), "Minimize side panel");
        await firstCanvas.waitFor({ state: "hidden" });
        expect(await firstCanvas.count()).toBe(1);
        expect(await rfb.events()).not.toContain("closed:1");
        await page.clock.fastForward(30_001);
        await expect.poll(() => rfb.events()).toContain("closed:1");
        expect(await firstCanvas.count()).toBe(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("preserves the production header-action shapes for Side chat and Discussion", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const mainCompanionKey = "agent:main:main";
    await seedMainCompanionLayout(page, suite.server.baseUrl, mainCompanionKey);
    await installMockGateway(page, {
      ...coldOpenScenario(true),
      sessionKey: mainCompanionKey,
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainCompanionKey));
    await waitForControlUiGatewayReady(page);
    await page.locator('[data-panel-slot="companion"][data-region="main"]').waitFor();
    const contentActions = page.locator(".chat-pane__header-trailing");
    const clearAction = contentActions.getByRole("button", {
      name: "Clear side chat",
      exact: true,
    });
    await clearAction.waitFor();
    expect(await clearAction.locator('path[d^="M3 6h18M19 6v14"]').count()).toBe(1);
    expect(await contentActions.locator("wa-dropdown").count()).toBe(0);
    const clearTooltip = clearAction.locator("..");
    await clearAction.hover();
    await expect
      .poll(() =>
        clearTooltip
          .locator(".tooltip-surface[popover]")
          .evaluate((tooltip) => tooltip.matches(":popover-open")),
      )
      .toBe(true);
    expect(await clearTooltip.locator(".tooltip-content").textContent()).toContain(
      "Clear side chat",
    );

    const tab = page.locator('.side-panel__header .tabstrip-tab[aria-selected="true"]');
    for (const direction of ["ltr", "rtl"] as const) {
      const tabPadding = await tab.evaluate((node, dir) => {
        const panel = node.closest<HTMLElement>(".side-panel")!;
        panel.dir = dir;
        const close = node.nextElementSibling!;
        const bounds = (root: Element, selector: string) =>
          root.querySelector(selector)!.getBoundingClientRect();
        const tabBounds = node.getBoundingClientRect();
        const closeBounds = close.getBoundingClientRect();
        const leading = bounds(node, ".tabstrip-tab__icon svg");
        const label = bounds(node, ".tabstrip-tab__label");
        const clipper = bounds(node, ".tabstrip-tab__tooltip-trigger");
        const trailing = bounds(close, "svg");
        const rtl = dir === "rtl";
        const radii = (element: Element) => {
          const style = getComputedStyle(element);
          const values = [style.borderTopLeftRadius, style.borderTopRightRadius];
          return (rtl ? values.toReversed() : values).map(Number.parseFloat);
        };
        return {
          leading: rtl ? tabBounds.right - leading.right : leading.left - tabBounds.left,
          trailing: rtl ? trailing.left - closeBounds.left : closeBounds.right - trailing.right,
          labelInsets: [label.top - clipper.top, clipper.bottom - label.bottom],
          tabRadii: radii(node),
          closeContained:
            closeBounds.left >= tabBounds.left - 1 &&
            closeBounds.right <= tabBounds.right + 1 &&
            closeBounds.top >= tabBounds.top - 1 &&
            closeBounds.bottom <= tabBounds.bottom + 1,
        };
      }, direction);
      expect(tabPadding.trailing).toBeCloseTo(tabPadding.leading, 0);
      expect(Math.min(...tabPadding.labelInsets)).toBeGreaterThanOrEqual(0);
      expect(Math.min(...tabPadding.tabRadii)).toBeGreaterThan(0);
      expect(tabPadding.closeContained).toBe(true);
    }
    await tab.evaluate((node) => node.closest(".side-panel")!.removeAttribute("dir"));

    const sideHeader = page.locator('[data-region-header="side"]');
    await sideHeader.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .locator(".side-panel-launcher")
      .getByRole("button")
      .filter({ has: page.locator(".side-panel-type-option__label", { hasText: /^Discussion$/ }) })
      .click();
    const discussionAction = sideHeader.locator('a.rail-header__action[target="_blank"]');
    await discussionAction.waitFor();
    expect(await discussionAction.getAttribute("href")).toBe("https://discussion.example/session");

    await suite.closeBrowserContext(context);
  });

  it("renders content for every offered slot with backing data", async () => {
    for (const label of offeredSlotLabels) {
      expect(
        await readSlotColdOpenOutcome(label, coldOpenScenario(true), "content"),
        `${label} must render content when its backing capability has data`,
      ).toEqual({ outcome: "content" });
    }
  });

  it("finishes cold-open with content or an identified and explained empty state", async () => {
    for (const label of offeredSlotLabels) {
      const outcome = await readSlotColdOpenOutcome(label, coldOpenScenario());
      expect(outcome.outcome, `${label} finishes loading`).not.toBe("loading");
      if (outcome.outcome === "generic-empty") {
        expect(outcome.heading, `${label} identifies its empty state`).not.toBe("");
        expect(outcome.description, `${label} explains its empty state`).not.toBe("");
      }
      if (label === "Subagents") {
        expect(outcome).toEqual({
          outcome: "generic-empty",
          heading: "Subagents",
          description: "No subagents in this conversation.",
          emptyStateOffersAction: false,
        });
      } else if (label === "Processes") {
        expect(outcome).toEqual({
          outcome: "generic-empty",
          heading: "No processes",
          description: "No background processes in this conversation.",
          emptyStateOffersAction: false,
        });
      } else if (label === "Discussion") {
        expect(outcome).toMatchObject({
          outcome: "generic-empty",
          emptyStateOffersAction: false,
        });
      } else if (outcome.outcome === "generic-empty") {
        expect(outcome.emptyStateOffersAction, `${label} offers an enabled action`).toBe(true);
      }
    }
  });
});
