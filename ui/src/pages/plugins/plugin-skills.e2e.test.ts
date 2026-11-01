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

const skill = {
  name: "Calendar guide",
  description: "Configure your calendar and review all supporting files. ".repeat(16),
};
const catalogId = "ch_Y2FsZW5kYXI";
const entryPath = "SKILL.md";
const configPath = "references/config.md";
const scriptPath = "scripts/check.sh";
const readMethod = "plugins.skills.read";
const installedRoute = "settings/plugins/calendar-plus";
const bundle: PluginsSkillsReadResult = {
  name: skill.name,
  rootPath: "skills/calendar",
  entryPath,
  inventoryComplete: true,
  directories: ["references", "scripts", "empty"],
  files: Object.entries({
    [entryPath]: "# Calendar guide\n\nStart here. [Configuration](references/config.md)",
    [configPath]:
      "# Configuration\n\n" +
      "Complete author configuration guidance.\n\n".repeat(800) +
      "CONFIGURATION_TAIL",
    [scriptPath]: "echo calendar-check",
  }).map(([path, content]) => ({
    path,
    content,
    sizeBytes: content.length,
    status: "ready" as const,
  })),
};
const selectedBundle = (selectedPath: string, extraContent = ""): PluginsSkillsReadResult => ({
  ...bundle,
  files: bundle.files.map((file) =>
    file.path === selectedPath
      ? { ...file, content: file.content + extraContent }
      : { path: file.path, sizeBytes: file.sizeBytes, status: "deferred" },
  ),
});
type GatewayOptions = Parameters<typeof installMockGateway>[1];
async function setup(options: GatewayOptions = {}, route = installedRoute) {
  const context = await newContext();
  onTestFinished(() => context.close());
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods: [...pluginMethods, readMethod],
    methodResponses: responses(),
    ...options,
  });
  await page.goto(`${server.baseUrl}${route}`);
  const modal = page.locator("openclaw-file-preview-modal");
  return {
    page,
    gateway,
    modal,
    content: (selector: string) => expect.poll(() => modal.locator(selector).textContent()),
    file: (path: string, selected = false) =>
      modal.locator(`[data-path="${path}"]${selected ? '[aria-current="true"]' : ""}`),
    open: () => page.getByRole("button", { name: new RegExp(skill.name) }).click(),
    read: (after = 0) => gateway.waitForRequest(readMethod, { after }),
  };
}
function responses(installed = true) {
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
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [skill],
      versions: [],
    },
  };
  return {
    ...pluginMethodResponses(),
    "plugins.list": inventory(installed ? [calendarPlugin] : []),
    "plugins.catalog.get": detail,
    "plugins.inspect": {
      ...calendarInspection,
      plugin: calendarPlugin,
      catalog: detail,
      components: { ...calendarInspection.components, skills: [skill.name], skillDetails: [skill] },
    },
    [readMethod]: {
      cases: [...bundle.files.map(({ path }) => path), undefined].map((path) => ({
        match: path ? { path } : {},
        response: selectedBundle(path ?? entryPath),
      })),
    },
  };
}

describeControlUiE2e("Plugin skill bundle routes", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each([
    ["installed settings", installedRoute, true, "installed"],
    ["installed catalog", `plugins/${catalogId}`, true, "installed"],
    ["uninstalled catalog", `plugins/${catalogId}`, false, "catalog"],
  ] as const)(
    "opens the full bundle from %s without installing it",
    async (name, route, installed, source) => {
      const session = await setup({ methodResponses: responses(installed) }, route);
      const { page, gateway, modal, file, open, read, content } = session;
      if (name === "installed settings") {
        const descriptionSelector = ".plugin-skills-section .plugin-capability__copy > span";
        const description = page.locator(descriptionSelector);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(await description.textContent()).toBe(skill.description);
          // Query and measure together so a rerender cannot detach the sampled row.
          expect(
            await page.evaluate(
              (selector) =>
                Array.from(document.querySelectorAll(selector), (element) => {
                  const style = getComputedStyle(element);
                  const height = element.getBoundingClientRect().height;
                  return {
                    lineClamp: style.webkitLineClamp,
                    clamped: height <= Number.parseFloat(style.lineHeight) * 2 + 1,
                    overflowing: element.scrollHeight > height,
                  };
                }),
              descriptionSelector,
            ),
          ).toEqual([{ lineClamp: "2", clamped: true, overflowing: true }]);
          await captureScreenshot(page, `skill-row-${width}.png`, "viewport");
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await open();
      const request = await read();
      expect(request.params).toEqual(
        source === "installed"
          ? { source, pluginId: calendarPlugin.id, skillName: skill.name }
          : { source, catalogId, version: "2.1.0", skillName: skill.name },
      );
      await file(entryPath, true).waitFor();
      expect(await modal.getByRole("textbox").count()).toBe(0);
      expect(await modal.getByRole("button", { name: /Copy/ }).count()).toBe(0);
      expect(
        (await modal.locator("summary").allTextContents()).map((text) => text.trim()),
      ).toContain("empty");
      expect(await modal.locator(".item-meta, .chips, .state, .foot").count()).toBe(0);
      expect(await modal.locator(".head button[aria-label='Close']").count()).toBe(1);
      expect(await gateway.getRequests(readMethod)).toHaveLength(1);
      await gateway.deferNext(readMethod);
      await modal.getByRole("link", { name: "Configuration", exact: true }).click();
      expect((await read(1)).params).toMatchObject({ path: configPath });
      await modal
        .locator('openclaw-panel-loading-skeleton[data-panel-skeleton="document"]')
        .waitFor();
      expect(await modal.locator(".item").count()).toBe(3);
      await captureScreenshot(page, "skill-selected-skeleton.png", "viewport");
      await gateway.resolveDeferred(readMethod, selectedBundle(configPath));
      await file(configPath, true).waitFor();
      await content(".markdown").toContain("CONFIGURATION_TAIL");
      await file(scriptPath).click();
      await content(".code-content").toContain("echo calendar-check");
      await file(entryPath).click();
      await file(configPath).click();
      expect(await gateway.getRequests(readMethod)).toHaveLength(3);
      if (name === "installed settings") {
        for (const width of [1440, 1174, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          ).toBeLessThanOrEqual(1);
          await captureScreenshot(page, `skill-bundle-${width}.png`, "viewport");
        }
      }
      // Move off the file hint so Escape tests viewer dismissal.
      await modal.locator(".heading").hover();
      await page.keyboard.press("Escape");
      await expect.poll(() => modal.count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe(`/${route}`);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
    },
  );

  it("shows read failure, retries the same source, and discards a pending read on navigation", async () => {
    const { page, gateway, modal, file, open, read } = await setup({
      deferredMethods: [readMethod],
    });
    await open();
    await read();
    await modal.waitFor();
    expect(await modal.locator("openclaw-panel-loading-skeleton").count()).toBe(2);
    expect(await modal.locator(".body[aria-busy]").textContent()).not.toMatch(
      /Loading|Try another file name or content search\./,
    );
    expect(await modal.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
    await gateway.rejectDeferred(readMethod, { message: "Read failed" });
    await modal.getByRole("alert").waitFor();
    expect(await modal.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
    await modal.getByRole("button", { name: "Retry", exact: true }).click();
    await read(1);
    await file(entryPath, true).waitFor();
    expect((await gateway.getRequests(readMethod)).map((request) => request.params)).toEqual(
      Array.from({ length: 2 }, () => ({
        source: "installed",
        pluginId: calendarPlugin.id,
        skillName: skill.name,
      })),
    );
    await modal.getByRole("button", { name: /^Close/ }).click();
    await gateway.deferNext(readMethod);
    await open();
    await read(2);
    await page.evaluate(() => {
      history.pushState({}, "", "/settings/plugins");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(() => modal.count()).toBe(0);
    await gateway.resolveDeferred(readMethod, bundle);
    await page.getByRole("link", { name: calendarPlugin.name }).first().waitFor();
    expect(await modal.count()).toBe(0);
  });

  it("preserves the foreground reading position when a background file finishes", async () => {
    const guidance = "Read this guidance before proceeding.\n\n".repeat(100);
    const initial = selectedBundle(entryPath, "\n\n" + guidance);
    const { gateway, modal, file, open, read } = await setup({
      methodResponses: { ...responses(), [readMethod]: initial },
    });
    await open();
    await modal.locator(".markdown").waitFor();
    await gateway.deferNext(readMethod);
    await file(configPath).click();
    await read(1);
    await file(entryPath).click();
    await modal.locator(".markdown").waitFor();
    const body = modal.locator(".detail-body");
    await body.evaluate((element) => {
      element.scrollTop = 300;
    });
    const scrollTop = await body.evaluate((element) => element.scrollTop);
    expect(scrollTop).toBe(300);
    await gateway.resolveDeferred(readMethod, selectedBundle(configPath));
    // Await the controller's completed read and the actual modal render, not just RPC delivery.
    await expect
      .poll(() =>
        modal.evaluate(async (preview: HTMLElementTagNameMap["openclaw-file-preview-modal"]) => {
          await preview.updateComplete;
          return preview.files.find((entry) => entry.path === "references/config.md")?.contents;
        }),
      )
      .toContain("CONFIGURATION_TAIL");
    expect(await body.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    expect(await file(entryPath, true).count()).toBe(1);
  });

  it("retires the open viewer when the Gateway reconnects", async () => {
    const { page, gateway, modal, file, open, read } = await setup();
    await open();
    await file(entryPath, true).waitFor();
    await reconnectMockGateway(page, gateway, "after-skill-preview");
    expect(await modal.count()).toBe(0);
    await open();
    await read(1);
    await file(entryPath, true).waitFor();
  });
});
