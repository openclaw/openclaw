import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { reconnectMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

const skillSummary = "Configure your calendar and plan your week.";
const skill = {
  name: "Calendar guide",
  description: skillSummary + " Use the included guide for calendar setup and troubleshooting.",
};
const catalogId = "ch_Y2FsZW5kYXI";
const readMethod = "plugins.skills.read";
const installedRoute = "settings/plugins/calendar-plus";
const catalogRoute = "plugins/" + catalogId;
const shortDocument = [
  "# Calendar guide",
  "Start here. [Bundle guide](references/config.md) · [Calendar help](https://example.com/calendar) · [Unsafe](javascript:alert%281%29)",
].join("\n\n");
const longDocument = [
  shortDocument,
  "~~~sh\n" + "calendar check --availability ".repeat(18) + "\n~~~",
  "| First | Second | Third | Fourth | Fifth | Sixth | Seventh | Eighth | Ninth | Tenth |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n" +
    "| Repeat | Repeat | Repeat | Repeat | Repeat | Repeat | Repeat | Repeat | Repeat | Repeat |",
  "Read these steps before configuring your calendar.\n\n".repeat(25) + "End of the guide.",
].join("\n\n");
function bundle(content: string): PluginsSkillsReadResult {
  return {
    name: skill.name,
    rootPath: "skills/calendar",
    entryPath: "SKILL.md",
    inventoryComplete: false,
    directories: ["references"],
    files: [
      { path: "SKILL.md", content, sizeBytes: content.length, status: "ready" },
      { path: "references/config.md", sizeBytes: 3, status: "unavailable" },
    ],
  };
}

type GatewayOptions = Parameters<typeof installMockGateway>[1];
async function setup(installed: boolean, route: string, options: GatewayOptions = {}) {
  const context = await newContext({ width: 1280, height: 900 });
  onTestFinished(() => context.close());
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const gateway = await installMockGateway(page, {
    featureMethods: [...pluginMethods, readMethod],
    methodResponses: responses(installed),
    ...options,
  });
  await page.goto(server.baseUrl + route);
  const dialog = page.getByRole("dialog", { name: skill.name, exact: true });
  return {
    page,
    gateway,
    dialog,
    body: dialog.locator(".oc-dialog__body"),
    trigger: page.getByRole("button", { name: new RegExp(skill.name) }),
    heading: dialog
      .locator("article")
      .getByRole("heading", { name: skill.name, exact: true, level: 1 }),
    read: (after = 0) => gateway.waitForRequest(readMethod, { after }),
  };
}
function responses(installed: boolean) {
  const detail: PluginDiscoveryDetailResult = {
    plugin: {
      id: catalogId,
      catalog: {
        name: calendarPlugin.name,
        official: false,
        latestVersion: "2.1.0",
        categories: [],
      },
      local: {
        present: installed,
        installed,
        enabled: installed,
        state: installed ? "enabled" : "not-installed",
        ...(installed ? { pluginId: calendarPlugin.id } : {}),
        action: installed ? "manage" : "install",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: "@acme/calendar",
      ...(installed ? { author: { handle: "acme" } } : {}),
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [skill],
      versions: [],
    },
  };
  return {
    ...pluginMethodResponses(),
    "plugins.list": inventory(installed ? [{ ...calendarPlugin, catalogId }] : []),
    "plugins.catalog.get": detail,
    "plugins.inspect": {
      ...calendarInspection,
      plugin: calendarPlugin,
      catalog: detail,
      components: { ...calendarInspection.components, skills: [skill.name], skillDetails: [skill] },
    },
    [readMethod]: bundle(`---\nname: calendar\n---\n\tcalendar check\n\n${shortDocument}`),
  };
}

const installedParams = { source: "installed", pluginId: calendarPlugin.id, skillName: skill.name };

describeControlUiE2e("Plugin skill document routes", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each([
    ["installed settings", installedRoute, true],
    ["installed catalog", catalogRoute, true],
    ["uninstalled catalog", catalogRoute, false],
  ] as const)("opens only the skill document from %s", async (_name, route, installed) => {
    const { page, gateway, dialog, trigger, heading, read } = await setup(installed, route);
    if (!installed) {
      await page.setViewportSize({ width: 390, height: 680 });
    }
    await trigger.click();
    expect((await read()).params).toEqual(
      installed
        ? installedParams
        : { source: "catalog", catalogId, version: "2.1.0", skillName: skill.name },
    );
    await heading.waitFor();
    expect(await dialog.locator("article pre code").textContent()).toBe("calendar check\n");
    const header = dialog.locator("header");
    expect(await header.getByRole("heading").textContent()).toBe(skill.name);
    expect(await header.locator("p").textContent()).toBe(skillSummary);
    expect(await header.getByText("@acme", { exact: true }).count()).toBe(installed ? 1 : 0);
    expect(await dialog.getByRole("link", { name: "Calendar help" }).getAttribute("href")).toBe(
      "https://example.com/calendar",
    );
    expect(await dialog.getByRole("link").allTextContents()).toEqual(["Calendar help"]);
    expect(await dialog.getByText("Bundle guide", { exact: false }).count()).toBe(1);
    expect(await dialog.getByRole("button").all()).toHaveLength(1);
    expect(await dialog.getByRole("status").count()).toBe(0);
    expect(await gateway.getRequests(readMethod)).toHaveLength(1);
    if (!installed) {
      expect((await dialog.boundingBox())!.width).toBeLessThan(390);
      await captureScreenshot(page, "plugin-skill-short-narrow.png", "viewport");
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(new URL(page.url()).pathname).toBe("/" + route);
    expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
  });

  it("keeps one bounded reader through loading, unavailable entry, retry and a long document", async () => {
    const { page, gateway, dialog, body, trigger, heading, read } = await setup(
      true,
      installedRoute,
      {
        deferredMethods: [readMethod],
      },
    );
    await page.setViewportSize({ width: 390, height: 680 });
    await trigger.click();
    await read();
    await dialog.getByRole("status", { name: "Loading…" }).waitFor();
    const originalDialog = await dialog.elementHandle();
    const header = dialog.locator("header");
    const originalHeader = await header.textContent();
    const originalBounds = await dialog.boundingBox();
    await captureScreenshot(page, "plugin-skill-loading-narrow.png", "viewport");
    await gateway.resolveDeferred(readMethod, {
      ...bundle(shortDocument),
      files: [],
      version: "1.2.3",
    });
    await dialog.getByRole("alert").waitFor();
    expect(await heading.count()).toBe(0);
    expect(await dialog.boundingBox()).toEqual(originalBounds);
    await captureScreenshot(page, "plugin-skill-unavailable-narrow.png", "viewport");
    await gateway.deferNext(readMethod);
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    expect((await read(1)).params).toEqual({ ...installedParams, version: "1.2.3" });
    await dialog.getByRole("status", { name: "Loading…" }).waitFor();
    await gateway.resolveDeferred(readMethod, bundle(longDocument));
    await heading.waitFor();
    expect(await header.textContent()).toBe(originalHeader);
    expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(
      true,
    );
    expect(await dialog.boundingBox()).toEqual(originalBounds);
    const extents = await body.evaluate((element) => ({
      vertical: element.scrollHeight - element.clientHeight,
      horizontal: element.scrollWidth - element.clientWidth,
      overflow: ["pre", "table"].map((selector) => {
        const item = element.querySelector(selector)!;
        return item.scrollWidth - item.clientWidth;
      }),
    }));
    expect(extents.vertical).toBeGreaterThan(100);
    expect(extents.horizontal).toBeLessThanOrEqual(1);
    expect(extents.overflow.every((amount) => amount > 0)).toBe(true);
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    expect(await dialog.getByRole("button", { name: "Close", exact: true }).isVisible()).toBe(true);
  });

  it("retires a pending read on reconnect and discards it rather than reopening the reader", async () => {
    const { page, gateway, dialog, trigger, heading, read } = await setup(true, installedRoute, {
      deferredMethods: [readMethod],
    });
    await trigger.click();
    await read();
    await dialog.waitFor();
    await reconnectMockGateway(page, gateway, "after-skill-preview");
    await dialog.waitFor({ state: "hidden" });
    await trigger.click();
    await read(1);
    await heading.waitFor();
  });
});
