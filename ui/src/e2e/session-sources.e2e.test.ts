import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectText, expectCount } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session source settings" });
const featureMethods = [...defaultControlUiFeatureMethods, "plugins.list"];
const sources = ["Claude", "Codex", "OpenCode", "Pi"];
const plugins = ["anthropic", "codex", "opencode", "acpx"];
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const catalogConfigSchema = (key = "sessionCatalog") =>
  objectSchema({
    config: objectSchema({ [key]: objectSchema({ enabled: { type: "boolean", default: true } }) }),
  });
const entriesSchema = {
  anthropic: catalogConfigSchema(),
  codex: catalogConfigSchema(),
  opencode: catalogConfigSchema(),
  acpx: catalogConfigSchema("piSessionCatalog"),
};
const config = {
  plugins: {
    entries: {
      anthropic: { config: { sessionCatalog: { enabled: false } } },
      codex: { config: { sessionCatalog: { enabled: false }, supervision: { enabled: true } } },
      opencode: { config: { sessionCatalog: { enabled: false } } },
      acpx: { enabled: false, config: { timeoutSeconds: 42 } },
    },
  },
};
const methodResponses = {
  "plugins.list": {
    plugins: plugins.map((id) => ({
      id,
      enabled: id !== "acpx",
      installed: true,
    })),
  },
  "config.get": {
    config,
    raw: JSON.stringify(config),
    hash: "session-sources-0",
    valid: true,
  },
  "config.schema": {
    schema: objectSchema({
      plugins: objectSchema({
        entries: objectSchema(entriesSchema),
      }),
    }),
    uiHints: {},
    version: "session-sources",
  },
};

async function openSources(page: Page, options: Parameters<typeof installMockGateway>[1] = {}) {
  const gateway = await installMockGateway(page, {
    featureMethods,
    ...options,
    methodResponses: { ...methodResponses, ...options.methodResponses },
  });
  await page.goto(`${suite.server.baseUrl}settings/appearance#settings-session-sources`);
  await waitForControlUiSettingsTakeover(page);
  return { gateway, section: page.locator("#settings-session-sources") };
}

async function expectSwitches(section: ReturnType<Page["locator"]>, values: boolean[]) {
  await expect
    .poll(async () =>
      Promise.all((await section.getByRole("switch").all()).map((toggle) => toggle.isChecked())),
    )
    .toEqual(values);
}

suite.define(() => {
  it("supports keyboard and modified-click source settings navigation", async () => {
    await suite.withPage({}, async ({ page, context }) => {
      await installMockGateway(page, { featureMethods, methodResponses });
      await page.goto(new URL(controlUiSessionPath("agent:main:main"), suite.server.baseUrl).href);
      const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
      const item = page.getByRole("link", { name: "Session sources", exact: true });
      await trigger.click();
      const originalUrl = page.url();
      // Native tab gestures do not retain an opener.
      const [popup] = await Promise.all([
        context.waitForEvent("page"),
        item.click({ modifiers: ["ControlOrMeta"] }),
      ]);
      try {
        await popup.waitForLoadState("domcontentloaded");
        expect(new URL(popup.url())).toMatchObject({
          pathname: "/settings/appearance",
          hash: "#settings-session-sources",
        });
        expect(page.url()).toBe(originalUrl);
      } finally {
        await popup.close();
      }
      await page.keyboard.press("Escape");
      await item.waitFor({ state: "hidden" });
      await trigger.press("Enter");
      await item.focus();
      await page.keyboard.press("Enter");
      await waitForControlUiSettingsTakeover(page);
      expect(new URL(page.url()).hash).toBe("#settings-session-sources");
    });
  });

  it("indexes source labels before Appearance and waits for the catalog", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses,
        deferredMethods: ["plugins.list"],
      });
      await page.goto(`${suite.server.baseUrl}settings/about`);
      await waitForControlUiRoute(page, { pathname: "/settings/about", routeId: "about" });
      const sidebar = page.locator(".settings-sidebar");
      const search = sidebar.getByRole("searchbox", { name: "Search settings" });
      for (const source of sources) {
        await search.fill(`${source} sessions`);
        await sidebar.getByRole("link", { name: /Session sources/ }).waitFor();
      }
      await sidebar.getByRole("link", { name: /Session sources/ }).click();
      await gateway.waitForRequest("plugins.list");
      const section = page.locator("#settings-session-sources");
      await expectText(section, "Loading");
      expect(await section.getByRole("switch").count()).toBe(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await gateway.resolveDeferred("plugins.list");
      await expectCount(section.getByRole("switch"), 4);
    });
  });

  it("navigates from the sidebar and independently saves source preferences", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { featureMethods, methodResponses });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
      await page.getByRole("link", { name: "Session sources", exact: true }).click();
      await waitForControlUiSettingsTakeover(page);
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-session-sources");
      const section = page.locator("#settings-session-sources");
      const sourceRow = (source: string) =>
        section.locator(".settings-row", {
          hasText: `Show ${source === "Claude" ? "Claude Code" : source} sessions`,
        });
      await expectSwitches(section, [false, false, false, true]);
      await expect.poll(() => sourceRow("Codex").getByRole("switch").isDisabled()).toBe(false);
      expect(await section.locator(".settings-row__title").allTextContents()).toEqual([
        "Show Claude Code sessions",
        "Show Codex sessions",
        "Show OpenCode sessions",
        "Show Pi sessions",
      ]);

      for (const [source, pluginId, key, enabled] of [
        ["Codex", "codex", "sessionCatalog", true],
        ["Claude", "anthropic", "sessionCatalog", true],
        ["OpenCode", "opencode", "sessionCatalog", true],
        ["Pi", "acpx", "piSessionCatalog", false],
        ["Codex", "codex", "sessionCatalog", false],
      ] as const) {
        const row = sourceRow(source);
        const count = (await gateway.getRequests("config.set")).length;
        await row.click();
        await expect
          .poll(async () => (await gateway.getRequests("config.set")).length)
          .toBe(count + 1);
        const request = (await gateway.getRequests("config.set"))[count]!;
        const saved = JSON.parse(String(asNullableRecord(request.params)?.raw));
        expect(saved.plugins.entries[pluginId].config[key].enabled).toBe(enabled);
        expect(saved.plugins.entries).toMatchObject({
          codex: { config: { supervision: { enabled: true } } },
          acpx: { enabled: false, config: { timeoutSeconds: 42 } },
        });
        expect(saved.plugins.entries.acpx.config).not.toHaveProperty("sessionCatalog");
        await expect.poll(() => row.getByRole("switch").isChecked()).toBe(enabled);
      }

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expectSwitches(section, [true, false, true, false]);
    });
  });

  it.each([true, false])(
    "omits absent plugins with leftover config (OpenCode installed: %s)",
    async (installed) => {
      await suite.withPage({}, async ({ page }) => {
        const { gateway, section } = await openSources(page, {
          methodResponses: {
            "plugins.list": {
              plugins: methodResponses["plugins.list"].plugins.map((plugin) =>
                Object.assign({}, plugin, { installed: installed && plugin.id === "opencode" }),
              ),
            },
          },
        });
        await gateway.waitForRequest("plugins.list");
        await expectCount(section.getByRole("switch"), installed ? 1 : 0);
        if (installed) {
          expect(await section.locator(".settings-row__title").allTextContents()).toEqual([
            "Show OpenCode sessions",
          ]);
        } else {
          await expectText(section, "No supported session source plugins are installed");
          expect(
            await section.getByRole("link", { name: "Manage plugins" }).getAttribute("href"),
          ).toBe("/settings/plugins");
        }
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      });
    },
  );

  it.each([false, true])(
    "keeps installed sources disabled (missing schema: %s)",
    async (missingSchema) =>
      suite.withPage({}, async ({ page }) => {
        const { gateway, section } = await openSources(
          page,
          missingSchema
            ? { methodResponses: { "config.schema": { schema: objectSchema({}), uiHints: {} } } }
            : { operatorScopes: ["operator.read"] },
        );
        await expectCount(section.getByRole("switch"), 4);
        if (missingSchema) {
          await expectText(section, "Session source settings are unavailable");
        }
        for (const toggle of await section.getByRole("switch").all()) {
          expect(await toggle.isDisabled()).toBe(true);
        }
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      }),
  );
});
