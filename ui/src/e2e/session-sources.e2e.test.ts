import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionPath,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session source settings" });
const featureMethods = [...defaultControlUiFeatureMethods, "plugins.list"];
const catalogConfigSchema = (key = "sessionCatalog") => ({
  type: "object",
  properties: {
    config: {
      type: "object",
      properties: {
        [key]: {
          type: "object",
          properties: { enabled: { type: "boolean", default: true } },
        },
      },
    },
  },
});
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
    plugins: [
      { id: "anthropic", name: "Anthropic", enabled: true },
      { id: "codex", name: "Codex", enabled: true },
      { id: "opencode", name: "OpenCode", enabled: true },
      { id: "acpx", name: "ACPX", enabled: false },
    ].map((plugin) =>
      Object.assign({}, plugin, {
        installed: true,
        state: plugin.enabled ? "enabled" : "disabled",
      }),
    ),
    diagnostics: [],
    mutationAllowed: true,
  },
  "config.get": {
    config,
    raw: JSON.stringify(config),
    hash: "session-sources-0",
    valid: true,
  },
  "config.schema": {
    schema: {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              properties: {
                anthropic: catalogConfigSchema(),
                codex: catalogConfigSchema(),
                opencode: catalogConfigSchema(),
                acpx: catalogConfigSchema("piSessionCatalog"),
              },
            },
          },
        },
      },
    },
    uiHints: {},
    version: "session-sources",
  },
};

function isChecked(toggle: Locator) {
  return toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked);
}

suite.define(() => {
  it("opens session source settings with the keyboard and preserves modified-click navigation", async () => {
    await suite.withPage({}, async ({ page, context }) => {
      await installMockGateway(page, { featureMethods, methodResponses });
      await page.goto(new URL(controlUiSessionPath("agent:main:main"), suite.server.baseUrl).href);
      const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
      const item = page.getByRole("menuitem", { name: "Session sources…", exact: true });
      await trigger.click();
      const originalUrl = page.url();
      // Native tab gestures do not retain an opener.
      const [popup] = await Promise.all([
        context.waitForEvent("page"),
        item.locator("a").click({ modifiers: ["ControlOrMeta"] }),
      ]);
      try {
        await popup.waitForLoadState("domcontentloaded");
        expect(new URL(popup.url()).pathname).toBe("/settings/appearance");
        expect(new URL(popup.url()).hash).toBe("#settings-session-sources");
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

  it("finds session sources from the sidebar and independently saves discovery preferences", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { featureMethods, methodResponses });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
      await page.getByRole("menuitem", { name: "Session sources…", exact: true }).click();
      const { search, sidebar } = await waitForControlUiSettingsTakeover(page);
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-session-sources");
      const section = page.locator("#settings-session-sources");
      const claude = section.locator(".settings-row", { hasText: "Show Claude Code sessions" });
      const codex = section.locator(".settings-row", { hasText: "Show Codex sessions" });
      const opencode = section.locator(".settings-row", { hasText: "Show OpenCode sessions" });
      const pi = section.locator(".settings-row", { hasText: "Show Pi sessions" });
      await expect.poll(() => isChecked(claude.locator("wa-switch"))).toBe(false);
      await expect.poll(() => isChecked(codex.locator("wa-switch"))).toBe(false);
      await expect.poll(() => isChecked(opencode.locator("wa-switch"))).toBe(false);
      await expect.poll(() => isChecked(pi.locator("wa-switch"))).toBe(true);
      await expect
        .poll(() =>
          codex
            .locator("wa-switch")
            .evaluate((element) => (element as HTMLElement & { disabled: boolean }).disabled),
        )
        .toBe(false);

      const artifacts = createControlUiE2eArtifactDir("session-sources");
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, "session-sources-initial.png") });

      for (const [row, pluginId, key, enabled] of [
        [codex, "codex", "sessionCatalog", true],
        [claude, "anthropic", "sessionCatalog", true],
        [opencode, "opencode", "sessionCatalog", true],
        [pi, "acpx", "piSessionCatalog", false],
        [codex, "codex", "sessionCatalog", false],
      ] as const) {
        const count = (await gateway.getRequests("config.set")).length;
        await row.click();
        await expect
          .poll(async () => (await gateway.getRequests("config.set")).length)
          .toBe(count + 1);
        const request = (await gateway.getRequests("config.set"))[count]!;
        const saved = JSON.parse(String(asNullableRecord(request.params)?.raw));
        expect(saved.plugins.entries[pluginId].config[key].enabled).toBe(enabled);
        expect(saved.plugins.entries.codex.config.supervision.enabled).toBe(true);
        expect(saved.plugins.entries.acpx).toMatchObject({
          enabled: false,
          config: { timeoutSeconds: 42 },
        });
        expect(saved.plugins.entries.acpx.config).not.toHaveProperty("sessionCatalog");
        await expect.poll(() => isChecked(row.locator("wa-switch"))).toBe(enabled);
      }

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expect.poll(() => isChecked(claude.locator("wa-switch"))).toBe(true);
      await expect.poll(() => isChecked(codex.locator("wa-switch"))).toBe(false);
      await expect.poll(() => isChecked(opencode.locator("wa-switch"))).toBe(true);
      await expect.poll(() => isChecked(pi.locator("wa-switch"))).toBe(false);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, "session-sources-saved.png") });

      for (const source of ["Claude", "Codex", "OpenCode", "Pi"]) {
        await search.fill(`${source} sessions`);
        await sidebar.getByRole("link", { name: /Session sources/ }).click();
        await expect.poll(() => new URL(page.url()).hash).toBe("#settings-session-sources");
      }
    });
  });

  it("keeps discovery switches read-only for non-admin operators", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses,
        operatorScopes: ["operator.read"],
      });
      await page.goto(`${suite.server.baseUrl}settings/appearance#settings-session-sources`);
      await waitForControlUiSettingsTakeover(page);
      const switches = page.locator("#settings-session-sources wa-switch");
      await expect.poll(() => switches.count()).toBe(4);
      for (const toggle of await switches.all()) {
        expect(
          await toggle.evaluate(
            (element) => (element as HTMLElement & { disabled: boolean }).disabled,
          ),
        ).toBe(true);
      }
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });

  it.each([true, false])(
    "omits absent source plugins even with leftover config (OpenCode installed: %s)",
    async (installed) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods,
          methodResponses: {
            ...methodResponses,
            "plugins.list": {
              ...methodResponses["plugins.list"],
              plugins: methodResponses["plugins.list"].plugins.map((plugin) => ({
                ...plugin,
                installed: installed && plugin.id === "opencode",
                state: installed && plugin.id === "opencode" ? "enabled" : "not-installed",
              })),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/appearance#settings-session-sources`);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("plugins.list");
        const section = page.locator("#settings-session-sources");
        await expect.poll(() => section.locator("wa-switch").count()).toBe(installed ? 1 : 0);
        if (installed) {
          expect(await section.locator(".settings-row__title").allTextContents()).toEqual([
            "Show OpenCode sessions",
          ]);
        } else {
          await expect
            .poll(() => section.textContent())
            .toContain("No supported session source plugins are installed");
          expect(
            await section.getByRole("link", { name: "Manage plugins" }).getAttribute("href"),
          ).toBe("/settings/plugins");
        }
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      });
    },
  );

  it("keeps installed sources visible when their settings schema is unavailable", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses: {
          ...methodResponses,
          "config.schema": {
            schema: { type: "object", properties: {} },
            uiHints: {},
            version: "trimmed",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/appearance#settings-session-sources`);
      await waitForControlUiSettingsTakeover(page);
      const section = page.locator("#settings-session-sources");
      await expect.poll(() => section.locator("wa-switch").count()).toBe(4);
      await expect
        .poll(() => section.textContent())
        .toContain("Session source settings are unavailable");
      for (const toggle of await section.locator("wa-switch").all()) {
        expect(
          await toggle.evaluate(
            (element) => (element as HTMLElement & { disabled: boolean }).disabled,
          ),
        ).toBe(true);
      }
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });
});
