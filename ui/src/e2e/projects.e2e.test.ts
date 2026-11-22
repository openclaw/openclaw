import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Projects mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const config = {
  gateway: {
    roles: {
      default: "contractor",
      definitions: {
        admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        contractor: {
          sessions: { others: "none" },
          agents: ["main"],
          scopes: ["operator.sessions.write"],
          projects: ["site"],
        },
        operator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
        viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      },
    },
  },
};
const projects = [
  {
    id: "workspace:main",
    displayName: "main",
    source: "workspace",
    agentId: "main",
    repoRoot: "/home/openclaw/.openclaw/workspace",
  },
  {
    id: "site",
    displayName: "site",
    source: "registered",
    repositoryIdentity: "openclaw/site",
    repoRoot: "/srv/projects/site",
    originUrl: "https://github.com/openclaw/site.git",
  },
  {
    id: "docs",
    displayName: "docs",
    source: "cloned",
    repositoryIdentity: "openclaw/docs",
    repoRoot: "/home/openclaw/.openclaw/projects/docs",
    originUrl: "https://github.com/openclaw/docs.git",
  },
];

async function capture(page: Page, name: string) {
  // Let dialog and menu transitions finish so the proof shows settled surfaces.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: path.join(suite.artifactDir, name) });
}

suite.define(() => {
  it("lists projects, shares one with a role, and explains locked roles", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "projects.list",
          "projects.register",
          "projects.remove",
          "projects.rename",
          "projects.add",
        ],
        methodResponses: {
          "projects.list": { projects },
          "config.get": {
            raw: JSON.stringify(config),
            config,
            hash: "projects-config-0",
            valid: true,
          },
          "config.patch": { ok: true },
          "fs.listDir": {
            path: "/srv/projects",
            home: "/home/openclaw",
            parent: "/srv",
            entries: [
              { name: "api", path: "/srv/projects/api" },
              { name: "site", path: "/srv/projects/site" },
            ],
          },
          "projects.register": {
            id: "api",
            displayName: "api",
            source: "registered",
            repoRoot: "/srv/projects/api",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}projects`);
      await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
      const tabs = page.getByRole("tablist", { name: "Session sections" }).getByRole("tab");
      expect(await tabs.allTextContents()).toEqual(["Sessions", "Projects", "Worktrees"]);
      const site = page.locator("tbody tr", { hasText: "openclaw/site" });
      await expect.poll(() => site.textContent()).toContain("contractor");
      await capture(page, "projects-table.png");

      await page.getByRole("button", { name: "Register project" }).click();
      await page.getByRole("menuitem", { name: "Browse folders on this computer" }).waitFor();
      await capture(page, "projects-register-menu.png");
      await page.getByRole("menuitem", { name: "Browse folders on this computer" }).click();
      const browser = page.locator(".projects-browse");
      await browser.getByRole("option", { name: "api" }).waitFor();
      await capture(page, "projects-browse.png");
      await browser.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("projects.register")).map(({ params }) => params),
        )
        .toEqual([{ path: "/srv/projects" }]);
      await browser.waitFor({ state: "detached" });

      await page.getByRole("button", { name: "docs", exact: true }).click();
      const dialog = page.locator(".projects-detail");
      await dialog.waitFor();
      const contractor = dialog.getByRole("switch", { name: "contractor" });
      expect(await contractor.isChecked()).toBe(false);
      expect(await dialog.getByRole("switch", { name: "operator" }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("switch", { name: "viewer" }).isDisabled()).toBe(true);
      await capture(page, "projects-details.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, "projects-details-phone.png");
      await page.setViewportSize({ width: 1280, height: 900 });
      await contractor.click();
      await expect
        .poll(async () => (await gateway.getRequests("config.patch")).map(({ params }) => params))
        .toEqual([
          expect.objectContaining({
            raw: expect.stringContaining('"projects":["site","docs"]'),
          }),
        ]);
    }));
});
