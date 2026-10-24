import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/index.ts";
import type { DevicePairingList } from "../../../src/gateway/device-pairing-list.types.js";
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

const emptyDeviceResponses = {
  "node.list": { ts: 0, nodes: [] },
  "device.pair.list": { pending: [], paired: [] } satisfies DevicePairingList,
  "system-presence": [] satisfies PresenceEntry[],
};

const mobileGeometryCases = [
  { route: "sessions", contentSelector: ".settings-page" },
  { route: "appearance", contentSelector: ".settings-page" },
  { route: "memory", contentSelector: ".memory-page__panel .settings-page" },
  { route: "plugin-settings", contentSelector: ".settings-page" },
] as const satisfies ReadonlyArray<{ route: RouteId; contentSelector: string }>;

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

const desktopOptions = {
  ...createControlUiE2eContextOptions(),
  colorScheme: "dark" as const,
  viewport: { width: 1440, height: 900 },
};
const mobileOptions = { ...desktopOptions, viewport: { width: 390, height: 844 } };

async function visit(page: Page, route: RouteId) {
  const pathname = pathForRoute(route);
  await page.goto(new URL(pathname, suite.server.baseUrl).toString());
  await waitForControlUiRoute(page, { pathname, routeId: route });
}

function boxes(...locators: Locator[]) {
  return Promise.all(
    locators.map((locator) =>
      locator.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height, right: x + width, bottom: y + height };
      }),
    ),
  );
}

function padding(...locators: Locator[]) {
  return Promise.all(
    locators.map((locator) =>
      locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft)),
    ),
  );
}

function createCronLayoutMethodResponses() {
  const jobs: CronJob[] = ["healthy", "failing"].map((id) => ({
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
        // Keep cold documents alive so their idle imports cannot be cancelled by navigation.
        for (const pathname of ["new", "chat", "settings/model-providers"]) {
          const page = pathname === "new" ? firstPage : await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") {
              errors.push(message.text());
            }
          });
          page.on("requestfailed", (request) => {
            if (request.resourceType() === "script") {
              errors.push(request.url());
            }
          });
          page.on("response", (response) => {
            if (response.request().resourceType() === "script" && !response.ok()) {
              errors.push(response.url());
            }
          });
          await installMockGateway(page);
          await page.goto(new URL(pathname, suite.server.baseUrl).toString());
          if (pathname === "settings/model-providers") {
            await page.getByRole("heading", { name: /^Provider access\b/ }).waitFor();
            expect(await page.locator(".model-providers__defaults").textContent()).toContain(
              "Utility Model",
            );
            await openModelSetup(page);
            await page.getByText(/Find existing connections or prepare a local model/).waitFor();
          } else {
            await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          }
        }
        expect(errors).toEqual([]);
      },
    );
  });

  it("aligns settings-style workspace headers with their content columns", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
      await installMockGateway(page, { methodResponses: createCronLayoutMethodResponses() });
      for (const route of ["cron", "usage", "memory-import"] as const) {
        await visit(page, route);
        await expect
          .poll(async () => {
            const [header, content] = await boxes(
              page.locator(".content-header--settings").last(),
              page.locator(".settings-page").last(),
            );
            return [Math.round(header.x - content.x), Math.round(header.width - content.width)];
          })
          .toEqual([0, 0]);
      }
    });
  });

  it("aligns mobile shell, workspace, standalone, and custodian layouts", async () => {
    await suite.withPage(mobileOptions, async ({ page: initialPage, context }) => {
      let page = initialPage;
      await installMockGateway(page, { methodResponses: emptyDeviceResponses });
      await visit(page, "appearance");
      await expect
        .poll(() => padding(page.locator("main.content"), page.locator(".topbar")))
        .toEqual([12, 12]);
      await visit(page, "memory-import");
      expect(await padding(page.locator(".settings-page").last())).toEqual([12]);

      // Wide, narrow, nested-memory, and plugin surfaces share shell geometry.
      for (const { route, contentSelector } of mobileGeometryCases) {
        await page.close();
        page = await context.newPage();
        await installMockGateway(page);
        await visit(page, route);
        const workspace = page.locator(".settings-workspace").last();
        await expect
          .poll(async () => {
            const [scrollport, header, title, shell, content] = await boxes(
              page.locator("main.content"),
              page.locator(".content-header").last(),
              page.locator(".content-header").last().locator(".page-title"),
              workspace,
              workspace.locator(contentSelector),
            );
            // clientWidth excludes a non-overlay scrollbar and its stable gutter.
            const right =
              scrollport.x + (await page.locator("main.content").evaluate((el) => el.clientWidth));
            return [
              header.x,
              header.y,
              title.x,
              shell.x,
              right - shell.right,
              content.x,
              right - content.right,
            ].map(Math.round);
          })
          .toEqual([12, 70, 12, 12, 12, 12, 12]);
      }

      await visit(page, "appearance");
      await page.locator(".topbar-nav-toggle").click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      await page.locator(".settings-sidebar").getByRole("link", { name: "Ask OpenClaw" }).click();
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const [column] = await boxes(page.locator(".custodian__column"));
      expect([
        Math.round(column.x),
        Math.round(
          (await page.evaluate(() => document.documentElement.clientWidth)) - column.right,
        ),
      ]).toEqual([12, 12]);
      expect(await padding(page.locator("main.content"), page.locator(".topbar"))).toEqual([0, 12]);

      await page.setViewportSize(desktopOptions.viewport);
      await visit(page, "appearance");
      await expect
        .poll(() =>
          padding(
            page.locator(".config-content"),
            page.locator(".content-header"),
            page.locator(".settings-page"),
          ),
        )
        .toEqual([22, 16, 16]);
    });
  });

  it("keeps Automations search above one tab-and-action row", async () => {
    await suite.withPage(mobileOptions, async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      await installMockGateway(page, {
        methodResponses: createCronLayoutMethodResponses(),
      });

      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        await visit(page, "cron");

        await expect
          .poll(async () => {
            const primary = el(".cron-toolbar__primary");
            const [primaryBox, filters, actions, table, tabs] = await boxes(
              primary,
              el(".cron-toolbar__filters"),
              el(".cron-toolbar__actions"),
              el(".cron-table"),
              el(".cron-list-hub-tabs"),
            );
            return {
              actionsAboveTable: actions.bottom <= table.y,
              actionsRightAligned: Math.abs(table.right - actions.right) <= 1,
              actionsInlineWithTabs:
                Math.abs(actions.y + actions.height / 2 - (tabs.y + tabs.height / 2)) <= 1,
              filtersAbovePrimary: filters.bottom <= primaryBox.y,
              primaryContainsActions:
                (await primary.locator(".cron-toolbar__actions").count()) === 1,
            };
          })
          .toEqual({
            actionsAboveTable: true,
            actionsRightAligned: true,
            actionsInlineWithTabs: true,
            filtersAbovePrimary: true,
            primaryContainsActions: true,
          });
        expect(await el(".cron-toolbar__filters").getByRole("radiogroup").count()).toBe(0);
        expect(await el(".cron-stats").count()).toBe(0);
        expect(await el(".agent-scope-control__label").count()).toBe(0);
        expect(await el(".cron-table__name-text").allTextContents()).toEqual([
          "Failing automation",
          "Healthy automation",
        ]);

        await el(".agent-select__trigger").click();
        const pickerTitle = el(".agent-select__menu-title");
        await pickerTitle.waitFor();
        expect(await pickerTitle.textContent()).toBe("Agent");
        expect(
          await page
            .locator(".agent-select__menu")
            .evaluate((menu) => getComputedStyle(menu).opacity),
        ).toBe("1");

        await page.keyboard.press("Escape");
      }
    });
  });

  it("uses the shared tab system for Communications without duplicate section help", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      const config = {
        messages: { queueLimit: 5 },
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
              tts: { label: "Voice", docsUrl: "https://docs.openclaw.ai/tts" },
            },
            version: "communications-layout",
            generatedAt: new Date(0).toISOString(),
          },
        },
      });

      await visit(page, "communications");

      expect(await el(".config-sections-hub-tabs").count()).toBe(1);
      expect(await el(".settings-section__help-button").count()).toBe(0);
      const [subtitle, tabs, section] = await boxes(
        el(".page-subtitle"),
        el(".config-sections-hub-tabs"),
        el(".settings-section"),
      );
      const aboveTabs = tabs.y - subtitle.bottom;
      expect(aboveTabs).toBeGreaterThan(0);
      expect(Math.abs(section.y - tabs.bottom - aboveTabs)).toBeLessThanOrEqual(1);

      await el("#config-sections-tab-tts").click();
      await expect.poll(() => el("#config-sections-tab-tts").getAttribute("active")).not.toBeNull();
      expect(await el(".settings-section__help-button").count()).toBe(0);

      await page.setViewportSize(mobileOptions.viewport);
      await expect
        .poll(async () => {
          const [content, lead, mobileTabs] = await boxes(
            el("main.content"),
            el(".config-lead"),
            el(".config-sections-hub-tabs"),
          );
          const width = await el("main.content").evaluate((element) => element.clientWidth);
          return [lead.x, content.x + width - lead.right, mobileTabs.x].map(Math.round);
        })
        .toEqual([12, 12, 12]);
    });
  });

  it("keeps shared settings rows, introductions, links and actions aligned", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
      await installMockGateway(page, { methodResponses: emptyDeviceResponses });
      await visit(page, "appearance");
      const el = (selector: string) => page.locator(selector);
      const descriptions = el(".settings-row__text > .settings-row__title + .settings-row__desc");
      const gaps = await descriptions.evaluateAll((elements) =>
        elements.map((description) => {
          const title = description.previousElementSibling;
          if (!(title instanceof HTMLElement)) {
            throw new Error("Missing settings row title");
          }
          return Math.round(
            description.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
          );
        }),
      );
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps).toEqual(gaps.map(() => 0));
      await expect
        .poll(async () => {
          const [title, subtitle, heading, group] = await boxes(
            el(".page-title"),
            el(".page-subtitle"),
            el(".settings-section__heading").first(),
            el(".settings-section .settings-group").first(),
          );
          return [Math.round(subtitle.y - title.bottom), Math.round(heading.x - group.x)];
        })
        .toEqual([2, 0]);
      expect(await el(".settings-page__intro").count()).toBe(0);
      expect(
        await page
          .getByRole("link", { name: "Learn more", exact: true })
          .first()
          .evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("none");

      await visit(page, "cloud-workers");
      expect(await el(".page-subtitle").count()).toBe(0);
      await el(".cloud-environments__advanced > summary").click();
      await expect
        .poll(async () => {
          const [heading, group] = await boxes(
            el(".settings-section__heading").first(),
            el(".settings-section .settings-group").first(),
          );
          return Math.round(heading.x - group.x);
        })
        .toBe(0);

      await visit(page, "mcp");
      const heading = page.getByRole("heading", { name: "Configured servers", exact: true });
      const section = el(".settings-section").filter({ has: heading });
      const description = section.locator(".settings-section__desc");
      expect(
        await description
          .getByRole("link", { name: "Learn more", exact: true })
          .first()
          .evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("none");
      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        await expect
          .poll(async () => {
            const [outer, title, copy, action, group] = await boxes(
              section,
              heading,
              description,
              section.locator(".settings-section__actions"),
              section.locator(":scope > .settings-group"),
            );
            const mobile = viewport.width <= 640;
            return {
              actionPlacement: Math.round(action.y - (mobile ? copy.bottom : title.y)),
              actionGap: mobile ? null : Math.round(action.x - copy.right),
              actionRightInset: Math.round(outer.right - action.right),
              copyGap: Math.round(copy.y - title.bottom),
              groupClearance: Math.round(group.y - Math.max(copy.bottom, action.bottom)),
              overlapsAction:
                copy.x < action.right &&
                copy.right > action.x &&
                copy.y < action.bottom &&
                copy.bottom > action.y,
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
