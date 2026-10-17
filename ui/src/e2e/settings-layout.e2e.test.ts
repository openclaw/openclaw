import type { Locator, Page, Response } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
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

async function withPage(
  width: number,
  height: number,
  run: Parameters<typeof suite.withPage>[1],
  options?: Parameters<typeof installMockGateway>[1],
) {
  return suite.withPage(
    {
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width, height },
    },
    async (fixture) => {
      await installMockGateway(fixture.page, options);
      await run(fixture);
    },
  );
}

const boxes = (...locators: Locator[]) =>
  Promise.all(
    locators.map(async (locator) => {
      const box = await locator.boundingBox();
      return box && Object.assign(box, { right: box.x + box.width, bottom: box.y + box.height });
    }),
  );

function readLayout(selectors: Record<string, string | string[]>) {
  const layout: Record<
    string,
    {
      left: number;
      right: number;
      top: number;
      bottom: number;
      height: number;
      width: number;
      padding: number;
    }
  > = {};
  for (const [name, selector] of Object.entries(selectors)) {
    let element: HTMLElement | null = null;
    if (typeof selector === "string") {
      element = document.querySelector<HTMLElement>(selector);
    } else {
      let root: ParentNode = document;
      for (const [index, part] of selector.entries()) {
        const matches = root.querySelectorAll<HTMLElement>(part);
        element = matches.item(index === 0 ? matches.length - 1 : 0);
        if (!element) {
          return null;
        }
        root = element;
      }
    }
    if (!element) {
      return null;
    }
    const box = element.getBoundingClientRect();
    layout[name] = {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      height: box.height,
      width: element.clientWidth,
      padding: Number.parseFloat(getComputedStyle(element).paddingLeft),
    };
  }
  return layout;
}

async function visit(page: Page, route: RouteId) {
  const pathname = pathForRoute(route);
  await page.goto(new URL(pathname, suite.server.baseUrl).toString());
  await waitForControlUiRoute(page, { pathname, routeId: route });
}

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
  ...introRoutes.filter((route) => route !== "secrets" && route !== "updates"),
  "model-providers",
] as const;

const sectionAlignmentRoutes = [
  ...introRoutes.filter((route) => route !== "approvals"),
  "cloud-workers",
] as const;

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

const mobileSettingsRoutes = [...settingsRowRoutes, "logs"] as const satisfies readonly RouteId[];

const mobileStandaloneSettingsPageRoutes = [
  "usage",
  "cron",
  "memory-import",
] as const satisfies readonly RouteId[];

const mobileGeometryCases = [
  { route: "sessions", contentSelector: ".settings-page" },
  { route: "worktrees", contentSelector: ".settings-page" },
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
  { route: "cron", subtitle: "Scheduled tasks and recurring agent runs." },
  { route: "usage", subtitle: "API usage and costs." },
  {
    route: "memory-import",
    subtitle: "Bring Codex and Claude Code memory into an agent workspace.",
  },
] as const satisfies ReadonlyArray<{ route: RouteId; subtitle: string }>;

function createCronLayoutMethodResponses() {
  const jobs: CronJob[] = (["healthy", "failing"] as const).map((id) => ({
    id,
    configRevision: `${id}-revision`,
    name: id === "healthy" ? "Healthy automation" : "Failing automation",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: id },
    state: { lastRunStatus: id === "healthy" ? "ok" : "error" },
  }));
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
    "cron.runs": {
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
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
          "Find existing connections or prepare a local model for {agent}.",
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
              "Utility Model",
            );
            await openModelSetup(page);
            await page.getByText(/Find existing connections or prepare a local model/).waitFor();
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
    await withPage(
      1440,
      900,
      async ({ page }) => {
        for (const { route, subtitle } of standaloneHeaderCases) {
          await visit(page, route);

          const header = page.locator(".content-header--settings").last();
          const content = page.locator(".settings-page").last();
          await Promise.all([header.waitFor(), content.waitFor()]);
          await expect
            .poll(() => header.locator(".page-subtitle").textContent())
            .toContain(subtitle);
          await expect
            .poll(async () => {
              const [headerBox, contentBox] = await boxes(header, content);
              return headerBox && contentBox
                ? {
                    left: Math.round(headerBox.x - contentBox.x),
                    width: Math.round(headerBox.width - contentBox.width),
                  }
                : null;
            })
            .toEqual({ left: 0, width: 0 });
        }
      },
      { methodResponses: createCronLayoutMethodResponses() },
    );
  });

  it("aligns every mobile settings page with the topbar content", async () => {
    await withPage(390, 844, async ({ context, page: firstPage }) => {
      let page = firstPage;
      for (const route of mobileSettingsRoutes) {
        await visit(page, route);
        await expect
          .poll(
            async () => {
              const layout = await page.evaluate(readLayout, {
                content: "main.content",
                topbar: ".topbar",
              });
              return layout && Object.values(layout).map(({ padding }) => Math.round(padding));
            },
            { message: `${route} settings shell alignment` },
          )
          .toEqual([12, 12]);
      }

      for (const route of mobileStandaloneSettingsPageRoutes) {
        await visit(page, route);
        const settingsPage = page.locator(".settings-page").last();
        await settingsPage.waitFor({ state: "attached" });
        expect(
          await settingsPage.evaluate((element) =>
            Math.round(Number.parseFloat(getComputedStyle(element).paddingLeft)),
          ),
          `${route} mobile page-owned inset`,
        ).toBe(12);
      }

      for (const { route, contentSelector } of mobileGeometryCases) {
        await page.close();
        page = await context.newPage();
        await installMockGateway(page);
        await visit(page, route);
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
          .poll(async () => {
            const layout = await page.evaluate(readLayout, {
              scrollport: "main.content",
              header: [".content-header"],
              title: [".content-header", ".page-title"],
              workspace: [".settings-workspace"],
              surface: [".settings-workspace", contentSelector],
            });
            if (!layout) {
              return null;
            }
            const {
              scrollport,
              header: headerBox,
              title: titleBox,
              workspace: workspaceBox,
              surface,
            } = layout;
            // clientWidth excludes a non-overlay scrollbar and its stable gutter.
            const scrollportRight = scrollport.left + scrollport.width;
            return [
              headerBox.left,
              headerBox.top,
              titleBox.left,
              workspaceBox.left,
              scrollportRight - workspaceBox.right,
              surface.left,
              scrollportRight - surface.right,
            ].map(Math.round);
          })
          .toEqual([12, 70, 12, 12, 12, 12, 12]);
      }

      await visit(page, "appearance");
      await page.locator(".topbar-nav-toggle").click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      const settingsSidebar = page.locator(".settings-sidebar");
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const custodian = await page.evaluate(readLayout, {
        content: "main.content",
        column: ".custodian__column",
        topbar: ".topbar",
        root: "html",
      });
      expect(
        custodian && {
          columnLeft: Math.round(custodian.column.left),
          columnRightInset: Math.round(custodian.root.width - custodian.column.right),
          contentPaddingInline: Math.round(custodian.content.padding),
          topbarPaddingInline: Math.round(custodian.topbar.padding),
        },
      ).toEqual({
        columnLeft: 12,
        columnRightInset: 12,
        contentPaddingInline: 0,
        topbarPaddingInline: 12,
      });

      await page.setViewportSize({ height: 900, width: 1440 });
      await visit(page, "appearance");
      // The shared header transitions its padding after adopting the settings layout.
      await expect
        .poll(async () => {
          const layout = await page.evaluate(readLayout, {
            config: ".config-content",
            header: ".content-header",
            page: ".settings-page",
          });
          return layout && Object.values(layout).map(({ padding }) => padding);
        })
        .toEqual([22, 16, 16]);
    });
  });

  it("keeps Automations search above one tab-and-action row", async () => {
    await withPage(
      390,
      844,
      async ({ page }) => {
        for (const viewport of responsiveViewports) {
          await page.setViewportSize(viewport);
          await visit(page, "cron");

          await expect
            .poll(async () => {
              const layout = await page.evaluate(readLayout, {
                primary: ".cron-toolbar__primary",
                filters: ".cron-toolbar__filters",
                actions: ".cron-toolbar__actions",
                table: ".cron-table",
                tabs: ".cron-list-hub-tabs",
              });
              if (!layout) {
                return null;
              }
              const { primary, filters, actions: a, table, tabs } = layout;
              return {
                actionsAboveTable: a.bottom <= table.top,
                actionsRightAligned: Math.abs(table.right - a.right) <= 1,
                actionsInlineWithTabs:
                  Math.abs(a.top + a.height / 2 - (tabs.top + tabs.height / 2)) <= 1,
                filtersAbovePrimary: filters.bottom <= primary.top,
                primaryContainsActions: await page
                  .locator(".cron-toolbar__primary")
                  .evaluate((element) =>
                    element.contains(document.querySelector(".cron-toolbar__actions")),
                  ),
              };
            })
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
          ).toEqual(["All", "Active", "Paused", "Run history"]);
          expect(
            await Promise.all([
              page.locator(".cron-toolbar__filters").getByRole("radiogroup").count(),
              page.locator(".cron-stats").count(),
              page.locator(".agent-scope-control__label").count(),
            ]),
          ).toEqual([0, 0, 0]);
          expect(await page.locator(".cron-table__name-text").allTextContents()).toEqual([
            "Failing automation",
            "Healthy automation",
          ]);

          await page.locator(".agent-select__trigger").click();
          const pickerTitle = page.locator(".agent-select__menu-title");
          await pickerTitle.waitFor();
          expect(await pickerTitle.textContent()).toBe("Agent");
          expect(
            await page
              .locator(".agent-select__menu")
              .evaluate((menu) => getComputedStyle(menu).opacity),
          ).toBe("1");

          await page.keyboard.press("Escape");
        }
      },
      { methodResponses: createCronLayoutMethodResponses() },
    );
  });

  it("uses the shared tab system for Communications without duplicate section help", async () => {
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
    const options = {
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
    };

    await withPage(
      1440,
      900,
      async ({ page }) => {
        await visit(page, "communications");

        expect(await page.locator(".page-subtitle").textContent()).toBe(
          "Messages, text-to-speech, and meeting capture settings.",
        );
        expect(await page.locator(".config-sections-hub-tabs").count()).toBe(1);
        expect(
          (await page.locator(".config-sections-hub-tabs .hub-tab").allTextContents()).map(
            (label) => label.trim(),
          ),
        ).toEqual(["Messages", "Voice"]);
        expect(await page.locator(".settings-section__help-button").count()).toBe(0);
        const spacing = await page.evaluate(readLayout, {
          subtitle: ".page-subtitle",
          tabs: ".config-sections-hub-tabs",
          section: ".settings-section",
        });
        if (!spacing) {
          throw new Error("Communications layout did not render");
        }
        const aboveTabs = spacing.tabs.top - spacing.subtitle.bottom;
        expect(aboveTabs).toBeGreaterThan(0);
        expect(Math.abs(spacing.section.top - spacing.tabs.bottom - aboveTabs)).toBeLessThanOrEqual(
          1,
        );

        const advanced = page.locator("details.config-advanced-disclosure");
        // Scope to the disclosure's own summary; expanded advanced content can
        // add nested collapsible-object summaries a bare locator would match.
        const advancedSummary = advanced.locator(":scope > summary");
        await expect.poll(() => advanced.count()).toBe(1);
        await expect.poll(() => advanced.getAttribute("open")).toBeNull();
        await expect.poll(() => advancedSummary.textContent()).toContain("Advanced settings");

        await advancedSummary.click();
        await expect.poll(() => advanced.getAttribute("open")).not.toBeNull();
        await expect.poll(() => page.getByText("Response prefix", { exact: true }).count()).toBe(1);

        await page.locator("#config-sections-tab-tts").click();
        await page.waitForFunction(() =>
          document.querySelector("#config-sections-tab-tts")?.hasAttribute("active"),
        );
        expect(
          await page.locator("#config-sections-tab-tts").getAttribute("active"),
        ).not.toBeNull();
        expect(await page.locator(".settings-section__help-button").count()).toBe(0);

        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(async () => {
            const layout = await page.evaluate(readLayout, {
              content: "main.content",
              lead: ".config-lead",
              tabs: ".config-sections-hub-tabs",
            });
            if (!layout) {
              return null;
            }
            const { content, lead, tabs } = layout;
            return [lead.left, content.left + content.width - lead.right, tabs.left].map(
              Math.round,
            );
          })
          .toEqual([12, 12, 12]);
      },
      options,
    );
  });

  it("keeps settings rows, introductions, section headings, and Learn more links on one layout system", async () => {
    await withPage(1440, 900, async ({ page }) => {
      let auditedPairCount = 0;
      for (const route of settingsRowRoutes) {
        // Reload each route so earlier lazy styles cannot hide missing or misordered CSS.
        await visit(page, route);
        if (route === "model-providers") {
          await page
            .getByRole("heading", { name: "Defaults for all agents", exact: true })
            .waitFor();
        }

        if (route === "cloud-workers") {
          expect(await page.locator(".page-subtitle").count()).toBe(0);
          await page.locator(".cloud-environments__advanced > summary").click();
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
              const [titleBox, subtitleBox] = await boxes(title, subtitle);
              return titleBox && subtitleBox
                ? Math.round(subtitleBox.y - titleBox.y - titleBox.height)
                : null;
            })
            .toBe(2);
          expect(await page.locator(".settings-page__intro").count()).toBe(0);
        }

        if ((sectionAlignmentRoutes as readonly string[]).includes(route)) {
          const heading = page.locator(".settings-section__heading").first();
          const group = page.locator(".settings-section .settings-group").first();
          await heading.waitFor();
          await group.waitFor();
          await expect
            .poll(async () => {
              const [headingBox, groupBox] = await boxes(heading, group);
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
      }

      expect(auditedPairCount).toBeGreaterThan(0);

      const mcpSection = () =>
        page.locator(".settings-section").filter({
          has: page.getByRole("heading", { name: "Configured servers", exact: true }),
        });
      await visit(page, "mcp");
      const link = mcpSection()
        .locator(".settings-section__desc")
        .getByRole("link", { name: "Learn more", exact: true })
        .first();
      await link.waitFor();
      expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
        "none",
      );

      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        await visit(page, "mcp");
        const heading = page.getByRole("heading", {
          name: "Configured servers",
          exact: true,
        });
        const section = mcpSection();
        const description = section.locator(".settings-section__desc");
        const actions = section.locator(".settings-section__actions");
        const group = section.locator(":scope > .settings-group");
        await Promise.all([
          heading.waitFor(),
          description.waitFor(),
          actions.waitFor(),
          group.waitFor(),
        ]);
        await expect
          .poll(async () => {
            const [s, h, d, a, g] = await boxes(section, heading, description, actions, group);
            if (!s || !h || !d || !a || !g) {
              return null;
            }
            return {
              actionPlacement: Math.round(a.y - (viewport.width <= 640 ? d.bottom : h.y)),
              actionGap: viewport.width <= 640 ? null : Math.round(a.x - d.right),
              actionRightInset: Math.round(s.right - a.right),
              copyGap: Math.round(d.y - h.bottom),
              groupClearance: Math.round(g.y - Math.max(d.bottom, a.bottom)),
              overlapsAction: d.x < a.right && d.right > a.x && d.y < a.bottom && d.bottom > a.y,
            };
          })
          .toEqual({
            actionGap: viewport.width <= 640 ? null : 20,
            actionPlacement: viewport.width <= 640 ? 8 : 0,
            actionRightInset: 0,
            copyGap: 4,
            groupClearance: 12,
            overlapsAction: false,
          });
      }
    });
  });
});
