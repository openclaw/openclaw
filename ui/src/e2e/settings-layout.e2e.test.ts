import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page, Response } from "playwright";
import { expect, it } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/index.ts";
import type { DevicePairingList } from "../../../src/gateway/device-pairing-list.types.js";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const proofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureSettingsLayout(page: Page, filename: string) {
  if (!proofEnabled) {
    return;
  }
  const directory = path.join(suite.artifactDir, "settings-layout-audit");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(directory, filename),
  });
}

const emptyDeviceResponses = {
  "node.list": { ts: 0, nodes: [] },
  "device.pair.list": { pending: [], paired: [] } satisfies DevicePairingList,
  "system-presence": [] satisfies PresenceEntry[],
};
const mobileSettingsRoutes = ["profile", "plugins", "logs"] as const satisfies readonly RouteId[];
const mobileStandaloneSettingsPageRoutes = ["memory-import"] as const satisfies readonly RouteId[];
const mobileGeometryCases = [
  { route: "sessions", contentSelector: ".settings-page" },
  { route: "worktrees", contentSelector: ".settings-page" },
  { route: "usage", contentSelector: ".settings-page" },
  { route: "appearance", contentSelector: ".settings-page" },
  { route: "model-providers", contentSelector: ".settings-page" },
  { route: "memory", contentSelector: ".memory-page__panel .settings-page" },
  { route: "plugin-settings", contentSelector: ".settings-page" },
] as const satisfies ReadonlyArray<{ route: RouteId; contentSelector: string }>;

suite.define(() => {
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
          "Connect providers and choose the models your agents use.",
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
            ? page.getByRole("heading", { name: /^Providers\b/ })
            : page.locator(".agent-chat__composer-combobox textarea");
          await ready.waitFor();
          if (isSettings) {
            await page.locator("[data-models-more-settings]").click();
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
        const subtitle = page.locator(".content-header--settings .page-subtitle").last();
        expect((await subtitle.boundingBox())?.x, `${route} mobile subtitle column`).toBe(12);
      }

      for (const { route, contentSelector } of mobileGeometryCases) {
        const pathname = pathForRoute(route);
        if (route === "appearance" || route === "model-providers" || route === "memory") {
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
      const advanced = page.locator("details.config-advanced-disclosure");
      // Scope to the disclosure's own summary; expanded advanced content can
      // add nested collapsible-object summaries a bare locator would match.
      const advancedSummary = advanced.locator(":scope > summary");
      await expect.poll(() => advanced.count()).toBe(1);
      await expect.poll(() => advanced.getAttribute("open")).toBeNull();
      await expect.poll(() => advancedSummary.textContent()).toContain("Advanced settings");
      await captureSettingsLayout(page, "communications-messages.png");

      await advancedSummary.click();
      await expect.poll(() => advanced.getAttribute("open")).not.toBeNull();
      await expect.poll(() => page.getByText("Response prefix", { exact: true }).count()).toBe(1);
      await captureSettingsLayout(page, "communications-advanced-expanded.png");

      const prefixRow = advanced.locator(".settings-row", {
        has: page.getByText("Response prefix", { exact: true }),
      });
      for (const width of [390, 820, 1400]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            prefixRow.evaluate((row, viewportWidth) => {
              const title = row.querySelector(".settings-row__title")!.getBoundingClientRect();
              const input = row.querySelector("input")!.getBoundingClientRect();
              const summary = row.parentElement!.querySelector("summary")!;
              const text = summary.querySelector(".settings-row__text")!.getBoundingClientRect();
              const chevron = summary
                .querySelector(".settings-row__control")!
                .getBoundingClientRect();
              return {
                fieldLayout:
                  viewportWidth === 390
                    ? input.top >= title.bottom && input.width > 300
                    : input.left > title.right,
                summaryInline: chevron.left > text.right && chevron.top < text.bottom,
              };
            }, width),
          )
          .toEqual({ fieldLayout: true, summaryInline: true });
      }

      await page.locator("#config-sections-tab-tts").click();
      await page.waitForFunction(() =>
        document.querySelector("#config-sections-tab-tts")?.hasAttribute("active"),
      );
      expect(await page.locator("#config-sections-tab-tts").getAttribute("active")).not.toBeNull();
      expect(await page.locator(".settings-section__help-button").count()).toBe(0);
      await captureSettingsLayout(page, "communications-voice.png");
    } finally {
      await context.close();
    }
  });
});
