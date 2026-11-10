import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Response } from "playwright";
import { expect, it } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/index.ts";
import type { DevicePairingList } from "../../../src/gateway/device-pairing-list.types.js";
import type { CronJob } from "../api/types.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronRuns } from "./cron-fixtures.test-support.ts";
import { openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const proofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const emptyDeviceResponses = {
  "node.list": { ts: 0, nodes: [] },
  "device.pair.list": { pending: [], paired: [] } satisfies DevicePairingList,
  "system-presence": [] satisfies PresenceEntry[],
};

const introRoutes = [
  "appearance",
  "approvals",
  "labs",
  "mcp",
  "secrets",
  "security",
  "talk",
  "updates",
] as const;

const learnMoreRoutes = [
  "appearance",
  "approvals",
  "labs",
  "mcp",
  "model-providers",
  "security",
  "talk",
] as const;

const sectionAlignmentRoutes = [
  "appearance",
  "cloud-workers",
  "mcp",
  "secrets",
  "talk",
  "updates",
] as const;

const actionSectionCases = [{ route: "mcp", heading: "Servers" }] as const;

const settingsRowRoutes = [
  "profile",
  "appearance",
  "lobsterdex",
  "notifications",
  "connection",
  "channels",
  "communications",
  "talk",
  "devices",
  "cloud-workers",
  "agents",
  "ai-agents",
  "labs",
  "model-providers",
  "mcp",
  "memory",
  "automation",
  "security",
  "secrets",
  "approvals",
  "infrastructure",
  "updates",
  "advanced",
  "plugins",
  "about",
  "debug",
] as const satisfies readonly RouteId[];

const mobileSettingsRoutes = ["profile", "plugins", "logs"] as const satisfies readonly RouteId[];

const mobileStandaloneSettingsPageRoutes = ["memory-import"] as const satisfies readonly RouteId[];

const mobileGeometryCases = [
  { route: "sessions", contentSelector: ".settings-page" },
  { route: "worktrees", contentSelector: ".settings-page" },
  { route: "usage", contentSelector: ".settings-page" },
  { route: "cron", contentSelector: ".settings-page" },
  { route: "appearance", contentSelector: ".settings-page" },
  { route: "model-providers", contentSelector: ".settings-page" },
  { route: "memory", contentSelector: ".memory-page__panel .settings-page" },
  { route: "plugin-settings", contentSelector: ".settings-page" },
] as const satisfies ReadonlyArray<{ route: RouteId; contentSelector: string }>;

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

const standaloneHeaderCases = [
  { route: "cron", subtitle: "Schedule recurring tasks for your agent." },
  { route: "usage", subtitle: "API usage and costs." },
  {
    route: "memory-import",
    subtitle: "Bring Codex and Claude Code memory into an agent workspace.",
  },
] as const satisfies ReadonlyArray<{ route: RouteId; subtitle: string }>;

function createCronLayoutMethodResponses() {
  const jobs: CronJob[] = [
    {
      id: "healthy",
      configRevision: "healthy-revision",
      name: "Healthy automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "healthy" },
      state: { lastRunStatus: "ok" },
    },
    {
      id: "failing",
      configRevision: "failing-revision",
      name: "Failing automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "failing" },
      state: { lastRunStatus: "error" },
    },
  ];
  return {
    "agents.list": {
      agents: [
        { id: "main", identity: { name: "Molty" }, name: "Molty" },
        { id: "writer", identity: { name: "Writer" }, name: "Writer" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    },
    "cron.list": cronListResponseFixture({
      jobs,
      snapshotRevision: "settings-layout",
      total: jobs.length,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    }),
    "cron.runs": cronRuns([]),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("keeps agent identity controls inside their fields at desktop and mobile widths", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
      });
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      const editor = page.locator(".agent-identity-editor");
      await editor.waitFor();

      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        for (const [name, control] of [
          ["Display name", editor.getByRole("textbox", { name: "Display name" })],
          ["Emoji input", editor.getByRole("textbox", { name: "Emoji" })],
          ["Emoji picker", editor.getByRole("button", { name: "Choose emoji" })],
        ] as const) {
          await control.focus();
          await expect
            .poll(
              () =>
                control.evaluate((element) => {
                  const inputBox = element.getBoundingClientRect();
                  const fieldBox = element.closest(".field")!.getBoundingClientRect();
                  const cardBox = element.closest(".settings-row")!.getBoundingClientRect();
                  return (
                    inputBox.width > 0 &&
                    inputBox.left >= Math.max(fieldBox.left, cardBox.left) - 1 &&
                    inputBox.right <= Math.min(fieldBox.right, cardBox.right) + 1
                  );
                }),
              { message: `${name} input is contained at ${viewport.width}px` },
            )
            .toBe(true);
        }
      }
    });
  });

  it("loads provider-settings copy after New Session and Chat without startup errors", async () => {
    const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    await suite.withPage(
      createControlUiE2eContextOptions(),
      async ({ context, page: firstPage }) => {
        const errors: string[] = [];
        const failedScripts: string[] = [];
        const startupResponses: Response[] = [];
        const settingsResponses: Response[] = [];
        const stopCapturing: Array<() => void> = [];
        const settingsOnlyCopy = [
          "Global model defaults and provider access for your agents.",
          "Find saved accounts or set up a local model for {agent}. This changes only this agent’s model, not the defaults for other agents.",
        ];
        // Keep each cold-boot document alive through the final assertions: replacing
        // an observed document cancels its idle imports and creates test-owned failures.
        for (const pathname of ["new", "chat", "settings/model-providers"]) {
          const page = pathname === "new" ? firstPage : await context.newPage();
          const isSettings = pathname === "settings/model-providers";
          const responses = isSettings ? settingsResponses : startupResponses;
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") {
              errors.push(message.text());
            }
          });
          page.on("requestfailed", (request) => {
            if (request.resourceType() === "script") {
              failedScripts.push(`${pathname}: ${request.url()} (${request.failure()?.errorText})`);
            }
          });
          await installMockGateway(page);
          const captureScript = (response: Response) => {
            if (response.request().resourceType() !== "script") {
              return;
            }
            if (!response.ok()) {
              failedScripts.push(`${pathname}: ${response.url()} (HTTP ${response.status()})`);
            }
            responses.push(response);
          };
          page.on("response", captureScript);
          stopCapturing.push(() => page.off("response", captureScript));

          await page.goto(`${suite.server.baseUrl}${pathname}`);
          const ready = isSettings
            ? page.getByRole("heading", { name: /^Provider access\b/ })
            : page.locator(".agent-chat__composer-combobox textarea");
          await ready.waitFor();
          if (isSettings) {
            expect(await page.locator(".model-providers__defaults").textContent()).toContain(
              "Utility model",
            );
            await openModelSetup(page);
            await page.getByText(/Find saved accounts or set up a local model/).waitFor();
          }
          if (recordVisuals) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${isSettings ? "settings" : pathname}.png`),
              fullPage: true,
            });
          }
        }
        // Observe without intercepting requests; keep documents alive until every
        // captured body is read, so teardown cannot cancel the work being asserted.
        stopCapturing.forEach((stop) => stop());
        const [startupScripts, settingsScripts] = await Promise.all(
          [startupResponses, settingsResponses].map(async (responses) =>
            (await Promise.all(responses.map((response) => response.text()))).join("\n"),
          ),
        );
        for (const copy of settingsOnlyCopy) {
          expect(startupScripts).not.toContain(copy);
          expect(settingsScripts).toContain(copy);
        }
        expect(errors).toEqual([]);
        expect(failedScripts).toEqual([]);
      },
    );
  });

  it("aligns settings-style workspace headers with their content columns", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: createCronLayoutMethodResponses(),
    });

    try {
      for (const { route, subtitle } of standaloneHeaderCases) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });

        const header = page.locator(".content-header--settings").last();
        const content = page.locator(".settings-page").last();
        await Promise.all([header.waitFor(), content.waitFor()]);
        await expect.poll(() => header.locator(".page-subtitle").textContent()).toContain(subtitle);
        await expect
          .poll(async () => {
            const [headerBox, contentBox] = await Promise.all([
              header.boundingBox(),
              content.boundingBox(),
            ]);
            return headerBox && contentBox
              ? {
                  left: Math.round(headerBox.x - contentBox.x),
                  width: Math.round(headerBox.width - contentBox.width),
                }
              : null;
          })
          .toEqual({ left: 0, width: 0 });
      }
    } finally {
      await context.close();
    }
  });

  it("aligns mobile settings shells and page-owned columns with the topbar", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    let page = await context.newPage();
    await installMockGateway(page, { methodResponses: emptyDeviceResponses });

    try {
      const navigate = (route: RouteId) =>
        evaluateControlUiContext(page, (app, routeId) => app.navigate(routeId), route);
      const readShellInsets = (route: RouteId) =>
        page.evaluate((activeRoute) => {
          const content = document.querySelector<HTMLElement>("main.content");
          const topbar = document.querySelector<HTMLElement>(".topbar");
          if (!content || !topbar) {
            throw new Error(`${activeRoute} settings shell did not render`);
          }
          return {
            contentPaddingInline: Math.round(
              Number.parseFloat(getComputedStyle(content).paddingLeft),
            ),
            topbarPaddingInline: Math.round(
              Number.parseFloat(getComputedStyle(topbar).paddingLeft),
            ),
          };
        }, route);

      // Keep an ordinary settings route and both workspace overrides; page geometry stays below.
      for (const [index, route] of mobileSettingsRoutes.entries()) {
        const pathname = pathForRoute(route);
        if (index === 0) {
          await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        } else {
          await navigate(route);
        }
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await expect
          .poll(() => readShellInsets(route), { message: `${route} settings shell alignment` })
          .toEqual({ contentPaddingInline: 12, topbarPaddingInline: 12 });
      }

      for (const route of mobileStandaloneSettingsPageRoutes) {
        const pathname = pathForRoute(route);
        await navigate(route);
        await waitForControlUiRoute(page, { pathname, routeId: route });
        const settingsPage = page.locator(".settings-page").last();
        await settingsPage.waitFor({ state: "attached" });
        expect(
          await settingsPage.evaluate((element) =>
            Math.round(element.firstElementChild!.getBoundingClientRect().left),
          ),
          `${route} mobile content column`,
        ).toBe(12);
      }

      for (const { route, contentSelector } of mobileGeometryCases) {
        const pathname = pathForRoute(route);
        // The desktop audit cold-loads these routes; keep fresh mobile loads for the rest.
        if (settingsRowRoutes.some((settingsRoute) => settingsRoute === route)) {
          await navigate(route);
        } else {
          await page.close();
          page = await context.newPage();
          await installMockGateway(page);
          await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        }
        await waitForControlUiRoute(page, { pathname, routeId: route });
        const header = page.locator(".content-header").last();
        const title = header.locator(".page-title");
        const workspace = page.locator(".settings-workspace").last();
        const contentSurface = workspace.locator(contentSelector);
        await Promise.all([
          header.waitFor(),
          title.waitFor(),
          workspace.waitFor(),
          contentSurface.waitFor(),
        ]);
        await expect
          .poll(() =>
            page.evaluate((selector) => {
              const scrollport = document.querySelector<HTMLElement>("main.content");
              const headers = document.querySelectorAll<HTMLElement>(".content-header");
              const workspaces = document.querySelectorAll<HTMLElement>(".settings-workspace");
              const headerElement = headers.item(headers.length - 1);
              const workspaceElement = workspaces.item(workspaces.length - 1);
              const titleElement = headerElement?.querySelector<HTMLElement>(".page-title");
              const surfaceElement = workspaceElement?.querySelector<HTMLElement>(selector);
              if (
                !scrollport ||
                !headerElement ||
                !titleElement ||
                !workspaceElement ||
                !surfaceElement
              ) {
                return null;
              }
              const scrollportBox = scrollport.getBoundingClientRect();
              const headerBox = headerElement.getBoundingClientRect();
              const titleBox = titleElement.getBoundingClientRect();
              const workspaceBox = workspaceElement.getBoundingClientRect();
              const contentSurfaceBox = surfaceElement.getBoundingClientRect();
              // clientWidth excludes a non-overlay scrollbar and its stable gutter.
              const scrollportRight = scrollportBox.left + scrollport.clientWidth;
              return {
                headerLeft: Math.round(headerBox.left),
                headerTop: Math.round(headerBox.top),
                titleLeft: Math.round(titleBox.left),
                workspaceLeft: Math.round(workspaceBox.left),
                workspaceRightInset: Math.round(scrollportRight - workspaceBox.right),
                contentLeft: Math.round(contentSurfaceBox.left),
                contentRightInset: Math.round(scrollportRight - contentSurfaceBox.right),
              };
            }, contentSelector),
          )
          .toEqual({
            contentLeft: 12,
            contentRightInset: 12,
            headerLeft: 12,
            // Clears the floating header; the title stays for assistive tech only.
            headerTop: 64,
            titleLeft: 11,
            workspaceLeft: 12,
            workspaceRightInset: 12,
          });
      }

      await navigate("appearance");
      await waitForControlUiRoute(page, {
        pathname: "/settings/appearance",
        routeId: "appearance",
      });
      await page.locator(".topbar-nav-toggle").click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      const settingsSidebar = page.locator(".settings-sidebar");
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const custodianInsets = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>("main.content");
        const column = document.querySelector<HTMLElement>(".custodian__column");
        const topbar = document.querySelector<HTMLElement>(".topbar");
        if (!content || !column || !topbar) {
          throw new Error("Custodian settings route did not render");
        }
        const columnBox = column.getBoundingClientRect();
        return {
          columnLeft: Math.round(columnBox.left),
          columnRightInset: Math.round(document.documentElement.clientWidth - columnBox.right),
          contentPaddingInline: Math.round(
            Number.parseFloat(getComputedStyle(content).paddingLeft),
          ),
          topbarPaddingInline: Math.round(Number.parseFloat(getComputedStyle(topbar).paddingLeft)),
        };
      });
      expect(custodianInsets).toEqual({
        columnLeft: 12,
        columnRightInset: 12,
        contentPaddingInline: 0,
        topbarPaddingInline: 12,
      });

      await page.setViewportSize({ height: 900, width: 1440 });
      await navigate("appearance");
      await waitForControlUiRoute(page, {
        pathname: "/settings/appearance",
        routeId: "appearance",
      });
      const readDesktopInsets = () =>
        page.evaluate(() => ({
          configPadding: Number.parseFloat(
            getComputedStyle(document.querySelector<HTMLElement>(".config-content")!).paddingLeft,
          ),
          headerPadding: Number.parseFloat(
            getComputedStyle(document.querySelector<HTMLElement>(".content-header")!).paddingLeft,
          ),
          pagePadding: Number.parseFloat(
            getComputedStyle(document.querySelector<HTMLElement>(".settings-page")!).paddingLeft,
          ),
        }));
      // The shared header transitions its padding after adopting the settings layout.
      await expect
        .poll(readDesktopInsets)
        .toEqual({ configPadding: 0, headerPadding: 16, pagePadding: 16 });
    } finally {
      await context.close();
    }
  });

  it("keeps config groups on the title's axis while the column narrows", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      for (const route of ["appearance", "notifications"] as const) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await page.locator(".settings-section .settings-group").first().waitFor();
        for (const width of [1440, 1100, 820]) {
          await page.setViewportSize({ height: 900, width });
          await expect
            .poll(
              () =>
                page.evaluate(() => {
                  const title = document.querySelector<HTMLElement>(".content-header .page-title");
                  const group = document.querySelector<HTMLElement>(
                    ".settings-section .settings-group",
                  );
                  return title && group
                    ? Math.round(
                        group.getBoundingClientRect().left - title.getBoundingClientRect().left,
                      )
                    : null;
                }),
              { message: `${route} at ${width}` },
            )
            .toBe(0);
        }
        await page.setViewportSize({ height: 900, width: 1440 });
      }
    } finally {
      await context.close();
    }
  });

  it("keeps wide page bodies on the title's axis at every width", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      for (const { route, surface } of [
        { route: "agents", surface: ".agents-layout" },
        { route: "logs", surface: ".logs-card" },
        { route: "lobsterdex", surface: ".lobsterdex-page" },
      ] as const) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await page.locator(surface).first().waitFor();
        for (const width of [1440, 1100, 820]) {
          await page.setViewportSize({ height: 900, width });
          await expect
            .poll(
              () =>
                page.evaluate((selector) => {
                  const title = document.querySelector<HTMLElement>(".content-header .page-title");
                  const body = document.querySelector<HTMLElement>(selector);
                  return title && body
                    ? Math.round(
                        body.getBoundingClientRect().left - title.getBoundingClientRect().left,
                      )
                    : null;
                }, surface),
              { message: `${route} at ${width}` },
            )
            .toBe(0);
        }
        await page.setViewportSize({ height: 900, width: 1440 });
      }
    } finally {
      await context.close();
    }
  });

  it("keeps Memory on one column across its tabs", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const pathname = pathForRoute("memory");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "memory" });
      for (const tab of ["Overview", "Memories", "Dreams", "Settings"]) {
        await page.locator(".memory-page").getByRole("tab", { name: tab, exact: true }).click();
        for (const width of [1440, 820]) {
          await page.setViewportSize({ height: 900, width });
          await expect
            .poll(
              () =>
                page.evaluate(() => {
                  const title = document.querySelector<HTMLElement>(".content-header .page-title");
                  const column = document.querySelector<HTMLElement>(
                    ".memory-page__panel .settings-page",
                  );
                  if (!title || !column) {
                    return null;
                  }
                  const box = column.getBoundingClientRect();
                  return {
                    offset: Math.round(
                      box.left +
                        Number.parseFloat(getComputedStyle(column).paddingLeft) -
                        title.getBoundingClientRect().left,
                    ),
                    fitsColumn: box.width <= (innerWidth === 820 ? innerWidth - 2 * 24 : 760),
                  };
                }),
              { message: `${tab} at ${width}` },
            )
            .toEqual({ offset: 0, fitsColumn: true });
        }
        await page.setViewportSize({ height: 900, width: 1440 });
      }
    } finally {
      await context.close();
    }
  });

  it("gives Settings one gutter and no new session between phone and sidebar", async () => {
    const context = await suite.browser.newContext({
      ...createDarkDesktopControlUiContextOptions(),
      viewport: { height: 900, width: 768 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { methodResponses: emptyDeviceResponses });

    try {
      for (const route of ["appearance", "devices"] as const) {
        const pathname = pathForRoute(route);
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, { pathname, routeId: route });
        await page.locator("main.content .page-title").waitFor();
        for (const width of [641, 768, 900]) {
          await page.setViewportSize({ height: 900, width });
          await expect
            .poll(
              () =>
                page.evaluate(() => {
                  const title = document.querySelector<HTMLElement>("main.content .page-title");
                  const rect = title?.getBoundingClientRect();
                  return rect && [Math.round(rect.left), Math.round(rect.top)];
                }),
              { message: `${route} at ${width}` },
            )
            .toEqual([24, 86]);
          expect(await page.locator(".topbar-search").count()).toBe(1);
          expect(await page.locator(".header-new-session").count()).toBe(0);
        }
        await page.setViewportSize({ height: 900, width: 768 });
      }

      const pathname = pathForRoute("usage");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "usage" });
      await page.locator(".header-new-session").waitFor();
    } finally {
      await context.close();
    }
  });

  it("switches the floating header, rows and controls together at 640", async () => {
    const context = await suite.browser.newContext({
      ...createDarkDesktopControlUiContextOptions(),
      viewport: { height: 900, width: 640 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const pathname = pathForRoute("connection");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "connection" });
      await page.locator(".settings-row--stacked-on-narrow").first().waitFor();
      const read = () =>
        page.evaluate(() => ({
          floating: document.querySelector(".shell--floating-header") !== null,
          control: getComputedStyle(document.documentElement)
            .getPropertyValue("--settings-control-height")
            .trim(),
          row: getComputedStyle(document.querySelector(".settings-row--stacked-on-narrow")!)
            .flexDirection,
        }));
      await expect.poll(read).toEqual({ floating: true, control: "38px", row: "column" });
      await page.setViewportSize({ height: 900, width: 641 });
      await expect.poll(read).toEqual({ floating: false, control: "32px", row: "row" });
    } finally {
      await context.close();
    }
  });

  it("sizes touch controls from the control height above phone width", async () => {
    const context = await suite.browser.newContext({
      ...createDarkDesktopControlUiContextOptions(),
      hasTouch: true,
      isMobile: true,
      viewport: { height: 768, width: 1024 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const pathname = pathForRoute("appearance");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "appearance" });
      const trigger = page.locator("main.content .settings-select .picker-select__trigger").first();
      await trigger.waitFor();
      await expect.poll(async () => (await trigger.boundingBox())?.height).toBe(38);
    } finally {
      await context.close();
    }
  });

  it("gives pickers and the agent menu one row height", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Main" },
            { id: "research", name: "Research" },
          ],
        },
      },
    });

    try {
      const pathname = pathForRoute("appearance");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "appearance" });
      const readRows = () =>
        page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll<HTMLElement>(".picker-select__option")]
              .filter((row) => !row.closest(".picker-select__sizer") && row.offsetParent)
              .map((row) => Math.round(row.getBoundingClientRect().height)),
          ),
        ]);
      for (const trigger of [
        "main.content .settings-select .picker-select__trigger",
        ".settings-sidebar .agent-select__trigger",
      ]) {
        await page.locator(trigger).first().click();
        await expect.poll(readRows).toEqual([28]);
        await page.keyboard.press("Escape");
      }
    } finally {
      await context.close();
    }
  });

  it("keeps Automations search above one tab-and-action row", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: createCronLayoutMethodResponses(),
    });

    try {
      await page.goto(`${suite.server.baseUrl}automations`);
      await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);

        await expect
          .poll(() =>
            page.evaluate(() => {
              const primary = document.querySelector<HTMLElement>(".cron-toolbar__primary");
              const filters = document.querySelector<HTMLElement>(".cron-toolbar__filters");
              const actions = document.querySelector<HTMLElement>(".cron-toolbar__actions");
              const table = document.querySelector<HTMLElement>(".cron-table");
              const tabGroup = document.querySelector<HTMLElement>(".cron-list-hub-tabs");
              if (!primary || !filters || !actions || !table || !tabGroup) {
                return null;
              }
              const primaryBox = primary.getBoundingClientRect();
              const filtersBox = filters.getBoundingClientRect();
              const actionsBox = actions.getBoundingClientRect();
              const tableBox = table.getBoundingClientRect();
              const tabBox = tabGroup.getBoundingClientRect();
              return {
                actionsAboveTable: actionsBox.bottom <= tableBox.top,
                actionsRightAligned: Math.abs(tableBox.right - actionsBox.right) <= 1,
                actionsInlineWithTabs:
                  Math.abs(
                    actionsBox.top + actionsBox.height / 2 - (tabBox.top + tabBox.height / 2),
                  ) <= 1,
                filtersAbovePrimary: filtersBox.bottom <= primaryBox.top,
                primaryContainsActions: primary.contains(actions),
              };
            }),
          )
          .toEqual({
            actionsAboveTable: true,
            actionsInlineWithTabs: true,
            actionsRightAligned: true,
            filtersAbovePrimary: true,
            primaryContainsActions: true,
          });

        expect(
          (await page.locator(".cron-list-hub-tabs .hub-tab").allTextContents()).map((label) =>
            label.trim(),
          ),
        ).toEqual(["All", "Active", "Paused", "Activity history"]);
        expect(await page.locator(".cron-toolbar__filters").getByRole("radiogroup").count()).toBe(
          0,
        );
        expect(await page.locator(".cron-stats").count()).toBe(0);
        expect(await page.locator(".agent-scope-control__label").count()).toBe(0);
        expect(await page.locator(".cron-table__name-text").allTextContents()).toEqual([
          "Failing automation",
          "Healthy automation",
        ]);

        if (proofEnabled) {
          const proofDir = path.join(suite.artifactDir, "settings-layout-audit");
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, `automations-toolbar-${viewport.width}.png`),
          });
        }
        await page.locator(".agent-select__trigger").click();
        const pickerTitle = page.locator(".agent-select__menu .oc-menu-heading__label");
        await pickerTitle.waitFor();
        expect(await pickerTitle.textContent()).toBe("Agent");
        expect(
          await page
            .locator(".agent-select__menu")
            .evaluate((menu) => getComputedStyle(menu).opacity),
        ).toBe("1");
        if (proofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              suite.artifactDir,
              "settings-layout-audit",
              `automations-agent-picker-${viewport.width}.png`,
            ),
          });
        }
        await page.keyboard.press("Escape");
        await pickerTitle.waitFor({ state: "hidden" });
      }
    } finally {
      await context.close();
    }
  });

  it("uses the shared tab system for Communications without duplicate section help", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    const config = {
      messages: { queueLimit: 5, responsePrefix: "[OpenClaw]" },
      tts: { auto: "off" },
    };
    const schema = {
      type: "object",
      properties: {
        messages: {
          type: "object",
          title: "Messages",
          properties: {
            queueLimit: { type: "integer", title: "Queue limit", minimum: 0 },
            responsePrefix: { type: "string", title: "Response prefix" },
          },
        },
        tts: {
          type: "object",
          title: "Voice",
          properties: {
            auto: {
              type: "string",
              title: "Automatic speech",
              enum: ["off", "always", "inbound", "tagged"],
            },
          },
        },
      },
    };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          path: "~/.openclaw/openclaw.json",
          exists: true,
          raw: `${JSON.stringify(config, null, 2)}\n`,
          hash: "communications-config-hash",
          appliedConfigHash: "communications-config-hash",
          valid: true,
          config,
          issues: [],
        },
        "config.schema": {
          schema,
          uiHints: {
            messages: {
              label: "Messages",
              docsUrl: "https://docs.openclaw.ai/concepts/messages",
            },
            "messages.queueLimit": { advanced: false },
            "messages.responsePrefix": { advanced: true },
            tts: { label: "Voice", docsUrl: "https://docs.openclaw.ai/tts" },
          },
          version: "communications-layout",
          generatedAt: new Date(0).toISOString(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/communications`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/communications",
        routeId: "communications",
      });

      expect(await page.locator(".page-subtitle").textContent()).toBe(
        "Messages, text-to-speech, and meeting capture settings.",
      );
      expect(await page.locator(".config-sections-hub-tabs").count()).toBe(1);
      expect(
        (await page.locator(".config-sections-hub-tabs .hub-tab").allTextContents()).map((label) =>
          label.trim(),
        ),
      ).toEqual(["Messages", "Voice"]);
      expect(await page.locator(".settings-section__help-button").count()).toBe(0);
      const spacing = await page.evaluate(() => {
        const subtitle = document.querySelector<HTMLElement>(".page-subtitle");
        const tabs = document.querySelector<HTMLElement>(".config-sections-hub-tabs");
        const section = document.querySelector<HTMLElement>(".settings-section");
        if (!subtitle || !tabs || !section) {
          throw new Error("Communications layout did not render");
        }
        return {
          aboveTabs: tabs.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom,
          belowTabs: section.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
        };
      });
      expect(spacing.aboveTabs).toBeGreaterThan(0);
      expect(Math.abs(spacing.belowTabs - spacing.aboveTabs)).toBeLessThanOrEqual(1);

      const advanced = page.locator("details.config-advanced-disclosure");
      // Scope to the disclosure's own summary; expanded advanced content can
      // add nested collapsible-object summaries a bare locator would match.
      const advancedSummary = advanced.locator(":scope > summary");
      await expect.poll(() => advanced.count()).toBe(1);
      await expect.poll(() => advanced.getAttribute("open")).toBeNull();
      await expect.poll(() => advancedSummary.textContent()).toContain("Advanced settings");
      if (proofEnabled) {
        await mkdir(path.join(suite.artifactDir, "settings-layout-audit"), { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-messages.png",
          ),
        });
      }

      await advancedSummary.click();
      await expect.poll(() => advanced.getAttribute("open")).not.toBeNull();
      await expect.poll(() => page.getByText("Response prefix", { exact: true }).count()).toBe(1);
      if (proofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-advanced-expanded.png",
          ),
        });
      }

      await page.locator("#config-sections-tab-tts").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-sections-tab-tts")?.hasAttribute("active"),
      );
      expect(await page.locator("#config-sections-tab-tts").getAttribute("active")).not.toBeNull();
      expect(await page.locator(".settings-section__help-button").count()).toBe(0);
      if (proofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "settings-layout-audit"),
            "communications-voice.png",
          ),
        });
      }

      await page.setViewportSize({ height: 844, width: 390 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const content = document.querySelector<HTMLElement>("main.content");
            const lead = document.querySelector<HTMLElement>(".config-lead");
            const tabs = document.querySelector<HTMLElement>(".config-sections-hub-tabs");
            if (!content || !lead || !tabs) {
              return null;
            }
            const contentBox = content.getBoundingClientRect();
            const leadBox = lead.getBoundingClientRect();
            const tabsBox = tabs.getBoundingClientRect();
            return {
              leadLeft: Math.round(leadBox.left),
              leadRightInset: Math.round(contentBox.left + content.clientWidth - leadBox.right),
              tabsLeft: Math.round(tabsBox.left),
            };
          }),
        )
        .toEqual({ leadLeft: 12, leadRightInset: 12, tabsLeft: 12 });
    } finally {
      await context.close();
    }
  });

  it("keeps settings rows, introductions, section headings, and Learn more links on one layout system", async () => {
    const context = await suite.browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, { methodResponses: emptyDeviceResponses });

    try {
      if (proofEnabled) {
        await mkdir(path.join(suite.artifactDir, "settings-layout-audit"), { recursive: true });
      }

      let auditedPairCount = 0;
      for (const route of settingsRowRoutes) {
        const pathname = pathForRoute(route);
        // Reload each route so earlier lazy styles cannot hide missing or misordered CSS.
        await page.goto(new URL(pathname, suite.server.baseUrl).toString());
        await waitForControlUiRoute(page, {
          pathname,
          routeId: route,
        });
        if (route === "model-providers") {
          await page
            .getByRole("heading", { name: "Defaults for all agents", exact: true })
            .waitFor();
        }

        if (route === "cloud-workers") {
          expect(await page.locator(".page-subtitle").count()).toBe(0);
          await page.locator(".settings-disclosure > summary").click();
        }

        const titleDescriptionPairs = page.locator(
          ".settings-row__text > .settings-row__title + .settings-row__desc",
        );
        const gaps = await titleDescriptionPairs.evaluateAll((descriptions) =>
          descriptions.map((description) => {
            const title = description.previousElementSibling;
            if (!(title instanceof HTMLElement)) {
              throw new Error("settings row description is missing its title");
            }
            const titleBox = title.getBoundingClientRect();
            const descriptionBox = description.getBoundingClientRect();
            return Math.round(descriptionBox.y - titleBox.y - titleBox.height);
          }),
        );
        auditedPairCount += gaps.length;
        expect(gaps, `${route} title/subtitle gaps`).toEqual(gaps.map(() => 0));

        if ((introRoutes as readonly string[]).includes(route)) {
          const title = page.locator(".page-title");
          const subtitle = page.locator(".page-subtitle");
          await title.waitFor();
          await subtitle.waitFor();
          await expect
            .poll(async () => {
              const [titleBox, subtitleBox] = await Promise.all([
                title.boundingBox(),
                subtitle.boundingBox(),
              ]);
              return titleBox && subtitleBox
                ? Math.round(subtitleBox.y - titleBox.y - titleBox.height)
                : null;
            })
            .toBe(2);
          expect(await page.locator(".settings-page__intro").count()).toBe(0);
          if (proofEnabled) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(
                path.join(suite.artifactDir, "settings-layout-audit"),
                `${route}.png`,
              ),
            });
          }
        }

        if ((sectionAlignmentRoutes as readonly string[]).includes(route)) {
          const heading = page
            .locator(route === "secrets" ? ".page-title" : ".settings-section__heading")
            .first();
          const group = page.locator(".settings-section .settings-group").first();
          await heading.waitFor();
          await group.waitFor();
          await expect
            .poll(async () => {
              const [headingBox, groupBox] = await Promise.all([
                heading.boundingBox(),
                group.boundingBox(),
              ]);
              return headingBox && groupBox ? Math.round(headingBox.x - groupBox.x) : null;
            })
            .toBe(0);
        }

        if ((learnMoreRoutes as readonly string[]).includes(route)) {
          const link = page.getByRole("link", { name: "Learn more", exact: true }).first();
          await link.waitFor();
          expect(
            await link.evaluate((element) => getComputedStyle(element).textDecorationLine),
          ).toBe("none");
        }
        for (const sectionCase of actionSectionCases.filter((entry) => entry.route === route)) {
          const heading = page.getByRole("heading", {
            name: sectionCase.heading,
            exact: true,
          });
          const section = page.locator(".settings-section").filter({ has: heading });
          const actions = section.locator(".settings-section__actions");
          const group = section.locator(":scope > .settings-group");
          await Promise.all([heading.waitFor(), actions.waitFor(), group.waitFor()]);
          // Cold route styles are covered above; this matrix checks responsive geometry.
          for (const viewport of responsiveViewports) {
            await page.setViewportSize(viewport);
            await expect
              .poll(async () => {
                const [sectionBox, headingBox, actionsBox, groupBox] = await Promise.all([
                  section.boundingBox(),
                  heading.boundingBox(),
                  actions.boundingBox(),
                  group.boundingBox(),
                ]);
                if (!sectionBox || !headingBox || !actionsBox || !groupBox) {
                  return null;
                }
                return {
                  actionPlacement: Math.round(
                    actionsBox.y + actionsBox.height / 2 - headingBox.y - headingBox.height / 2,
                  ),
                  actionRightInset: Math.round(
                    sectionBox.x + sectionBox.width - actionsBox.x - actionsBox.width,
                  ),
                  groupClearance: Math.round(
                    groupBox.y -
                      Math.max(headingBox.y + headingBox.height, actionsBox.y + actionsBox.height),
                  ),
                  headingLeftInset: Math.round(headingBox.x - sectionBox.x),
                };
              })
              .toEqual({
                actionPlacement: 0,
                actionRightInset: 0,
                groupClearance: 12,
                headingLeftInset: 0,
              });

            if (proofEnabled && viewport.width === 1440) {
              await section.screenshot({
                animations: "disabled",
                path: path.join(
                  path.join(suite.artifactDir, "settings-layout-audit"),
                  `action-${sectionCase.route}.png`,
                ),
              });
            }
          }
        }
      }

      expect(auditedPairCount).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
