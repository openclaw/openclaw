import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { iconData } from "../../components/icon-data.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createTemplateCatalogFixture,
  workflowOperator,
} from "./templates-catalog-gateway.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Template plugin names" });
const researchTemplate = {
  ...workflowOperator,
  packageName: "@maker/release-scout",
  displayName: "Release Scout",
};

async function capture(page: Page, name: string, content: Locator) {
  const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
    animations: "disabled",
  });
  await writeFile(suite.artifactDir + "/" + name + ".png", frame.png);
}

suite.define(() => {
  const fixture = createTemplateCatalogFixture(() => ({
    browser: suite.browser,
    baseUrl: suite.server.baseUrl,
  }));

  async function openDetail(page: Page) {
    const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
    await card.locator(".agents-home__template-card-link").click();
    const detail = page.locator(".plugin-catalog-detail");
    await detail.getByRole("heading", { level: 1 }).waitFor();
    return detail;
  }

  function pluginRelease(
    ref: string,
    version: string,
    name: string,
    imageUrl?: string,
  ): PluginDiscoveryDetailResult {
    return {
      plugin: {
        id: "ch_" + Buffer.from(ref).toString("base64url"),
        catalog: {
          name,
          packageName: ref,
          latestVersion: version,
          imageUrl,
          official: false,
          categories: [],
        },
        local: {
          present: false,
          installed: false,
          enabled: false,
          state: "not-installed",
          action: "install",
        },
      },
      detail: {
        origin: "clawhub",
        packageName: ref,
        selectedRelease: { version },
        topics: [],
        configuration: [],
        mcpServers: [],
        skills: [],
        versions: [],
      },
    };
  }

  it("holds unresolved plugin titles without holding the Template or replacing its controls", async () => {
    const { page, gateway } = await fixture({ width: 1280, height: 1060 });
    const packages = [
      { ref: "@expediagroup/expedia-openclaw", version: "1.2.0", label: "Expedia Travel" },
      { ref: "openclaw-travel-themes", version: "1.0.2", label: "Travel Themes" },
    ];
    await gateway.setMethodResponse("templates.catalog.detail", {
      detail: {
        ...workflowOperator,
        version: workflowOperator.latestVersion,
        agentId: "workflow-operator",
        workspaceFiles: 0,
        skills: 1,
        plugins: 2,
        mcpServers: 0,
        scheduledJobs: 0,
        contents: {
          instructions: [],
          skills: [
            {
              name: "@steipete/goplaces",
              source: "clawhub",
              ref: "@steipete/goplaces",
              version: "1.0.0",
            },
          ],
          integrations: packages.map(({ ref, version }) => ({
            kind: "plugin",
            source: "clawhub",
            name: ref,
            ref,
            version,
          })),
          automations: [],
        },
      },
    });
    await gateway.deferNext("plugins.list");
    for (const { version } of packages) {
      await gateway.deferNext("plugins.catalog.get", { version });
    }
    const detail = await openDetail(page);
    const plugins = detail.locator(".plugin-capabilities").filter({
      has: page.getByRole("heading", { name: "Plugins", exact: true }),
    });
    const rows = plugins.locator("summary");
    const titles = rows.locator(".settings-row__title");
    await rows.last().waitFor();
    await detail.getByRole("button", { name: "@steipete/goplaces" }).waitFor();
    expect(await titles.locator(".skeleton").count()).toBe(2);
    await gateway.resolveDeferred("plugins.list", {
      plugins: [],
      diagnostics: [],
      mutationAllowed: true,
      order: 0,
    });
    for (const { version } of packages) {
      await gateway.waitForRequest("plugins.catalog.get", { match: { version } });
    }
    await capture(page, "plugin-names-pending", plugins);
    expect(await titles.locator(".skeleton").count()).toBe(2);
    expect(await titles.locator(".template-plugin-name").count()).toBe(0);

    const first = rows.first();
    const firstRow = await first.elementHandle();
    expect(await first.ariaSnapshot()).toContain(packages[0]!.ref);
    const boxes = await Promise.all([rows.first().boundingBox(), rows.last().boundingBox()]);
    await first.focus();
    await page.keyboard.press("Enter");
    for (const { ref, version, label } of packages) {
      await gateway.resolveDeferred("plugins.catalog.get", pluginRelease(ref, version, label), {
        match: { version },
      });
      await plugins.getByText(label, { exact: true }).waitFor();
      expect(
        await gateway.getRequests("plugins.catalog.get", {
          id: "ch_" + Buffer.from(ref).toString("base64url"),
          version,
        }),
      ).toHaveLength(1);
    }
    expect(
      await firstRow.evaluate(
        (node) =>
          node.isConnected &&
          node === document.activeElement &&
          node.parentElement?.hasAttribute("open"),
      ),
    ).toBe(true);
    await page.keyboard.press("Enter");
    expect(await Promise.all([rows.first().boundingBox(), rows.last().boundingBox()])).toEqual(
      boxes,
    );
    expect(await gateway.getRequests("plugins.catalog.get")).toHaveLength(2);
    await page.mouse.move(3, 3);
    await first.blur();
    await capture(page, "plugin-names-settled", plugins);
  });

  it("settles missing plugin names without leaking names between Template releases", async () => {
    const { page, gateway } = await fixture(
      { width: 390, height: 844 },
      undefined,
      undefined,
      false,
      "light",
      false,
      [workflowOperator, researchTemplate],
    );
    const ref = "@openclaw/workflow-tools";
    const version = "2.0.0";
    const unavailable = { ref: "@maker/scout-tools", version: "3.0.0" };
    await gateway.setMethodResponse("plugins.list", {
      plugins: [],
      diagnostics: [],
      mutationAllowed: true,
      order: 0,
    });
    await gateway.deferNext("plugins.catalog.get", { version: "1.2.0" });
    await gateway.deferNext("plugins.catalog.get", { version });
    await gateway.deferNext("plugins.catalog.get", { version: unavailable.version });
    const first = await openDetail(page);
    await gateway.waitForRequest("plugins.catalog.get", { match: { version: "1.2.0" } });
    await first.getByRole("link", { name: "Templates", exact: true }).click();
    await gateway.setMethodResponse("templates.catalog.detail", {
      detail: {
        ...researchTemplate,
        version: researchTemplate.latestVersion,
        agentId: "release-scout",
        workspaceFiles: 0,
        skills: 0,
        plugins: 3,
        mcpServers: 0,
        scheduledJobs: 0,
        contents: {
          instructions: [],
          skills: [],
          integrations: [
            { kind: "plugin", source: "clawhub", name: ref, ref, version },
            {
              kind: "plugin",
              source: "bundled",
              name: ref,
              path: "plugins/bundled-workflow-tools",
            },
            { kind: "plugin", source: "clawhub", name: unavailable.ref, ...unavailable },
          ],
          automations: [],
        },
      },
    });
    const card = page
      .locator("[data-templates-entry]")
      .filter({ hasText: researchTemplate.displayName })
      .first();
    await card.locator(".agents-home__template-card-link").click();
    const detail = page.locator("openclaw-templates-detail-view");
    await detail.getByRole("heading", { level: 1, name: researchTemplate.displayName }).waitFor();
    await gateway.waitForRequest("plugins.catalog.get", { match: { version } });
    await gateway.waitForRequest("plugins.catalog.get", {
      match: { version: unavailable.version },
    });
    await gateway.resolveDeferred(
      "plugins.catalog.get",
      pluginRelease(ref, "1.2.0", "Old release name"),
      { match: { version: "1.2.0" } },
    );
    const rows = detail.locator(".plugin-capability__disclosure > summary");
    expect(await rows.first().locator(".skeleton").count()).toBe(1);
    expect(await rows.nth(1).locator(".template-plugin-name").textContent()).toBe(ref);
    await gateway.resolveDeferred(
      "plugins.catalog.get",
      pluginRelease(ref, version, "Workflow Toolkit"),
      { match: { version } },
    );
    await rows.first().getByText("Workflow Toolkit", { exact: true }).waitFor();
    await gateway.rejectDeferred(
      "plugins.catalog.get",
      { message: "Catalog lookup unavailable" },
      { match: { version: unavailable.version } },
    );
    await rows
      .last()
      .locator(".template-plugin-name")
      .getByText(unavailable.ref, { exact: true })
      .waitFor();
    expect(await rows.locator(".skeleton").count()).toBe(0);
    expect(await rows.locator(".template-plugin-name").allTextContents()).toEqual([
      "Workflow Toolkit",
      ref,
      unavailable.ref,
    ]);
    expect(await gateway.getRequests("plugins.catalog.get")).toHaveLength(3);
  });

  it.each(["installed", "catalog", "other installed release", "unavailable artwork"])(
    "shows %s plugin branding without registry labels or matching the wrong installed version",
    async (source) => {
      const { page, gateway } = await fixture();
      const exactInstall = source === "installed" || source === "unavailable artwork";
      await gateway.setMethodResponse("plugins.list", {
        plugins:
          source === "catalog"
            ? [
                {
                  id: "workflow-tools",
                  name: "Uninstalled official entry",
                  clawhubPackage: "@openclaw/workflow-tools",
                  origin: "official",
                  installed: false,
                  enabled: false,
                  state: "not-installed",
                },
              ]
            : [
                {
                  id: "workflow-tools",
                  name: exactInstall ? "Workflow Tools" : "Other Release",
                  clawhubPackage: "@openclaw/workflow-tools",
                  version: exactInstall ? "1.2.0" : "1.1.0",
                  hasIcon: true,
                  installed: true,
                  enabled: true,
                  state: "enabled",
                },
              ],
        diagnostics: [],
        mutationAllowed: true,
      });
      const imageUrl = "https://icons.example.test/workflow.png";
      await gateway.setMethodResponse(
        "plugins.catalog.get",
        pluginRelease("@openclaw/workflow-tools", "1.2.0", "Workflow Tools", imageUrl),
      );
      await page.route(/\/__openclaw__\/(?:plugin-icon|catalog-icon)\//u, (route) =>
        route.fulfill({
          status: source === "unavailable artwork" ? 404 : 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#4361ee"/><path d="m8 18 7 7 13-14" fill="none" stroke="#fff" stroke-width="4"/></svg>',
        }),
      );
      const iconResponse = page.waitForResponse((response) =>
        /\/__openclaw__\/(?:plugin-icon|catalog-icon)\//u.test(response.url()),
      );
      const detail = await openDetail(page);
      await iconResponse;
      const artwork = detail.locator(".plugin-capability__icon img");
      if (source === "unavailable artwork") {
        expect(await artwork.count()).toBe(0);
        expect(
          await detail
            .locator(".plugin-capability__disclosure")
            .filter({ hasText: "Workflow Tools" })
            .locator(".plugin-capability__icon svg")
            .count(),
        ).toBe(1);
      } else {
        await artwork.waitFor();
        await page.waitForFunction(() =>
          Array.from(
            document.querySelectorAll<HTMLImageElement>(".plugin-capability__icon img"),
          ).some((image) => image.complete && image.naturalWidth > 0),
        );
      }
      await capture(
        page,
        `dependency-provenance-${source}`,
        detail.getByRole("heading", { name: "Skills" }),
      );
      // Skill rows carry the Skills navigation glyph, not the docs book.
      expect(
        await detail
          .locator(".plugin-capabilities")
          .filter({ has: page.getByRole("heading", { name: "Skills" }) })
          .locator(".plugin-capability__icon path")
          .evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))),
      ).toEqual(iconData.sparkles.children.map(([, attributes]) => attributes.d));
      const rows = detail.locator(".plugin-capabilities");
      expect((await rows.allTextContents()).join(" ")).not.toContain("ClawHub · Version");
      await detail.getByText("Workflow Tools", { exact: true }).waitFor();
      expect(await detail.getByText("Installed", { exact: true }).count()).toBe(
        Number(exactInstall),
      );
      expect(await gateway.getRequests("plugins.catalog.get", { version: "1.2.0" })).toHaveLength(
        exactInstall ? 0 : 1,
      );
    },
  );
});
