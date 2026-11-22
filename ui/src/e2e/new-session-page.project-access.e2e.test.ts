import { expect, it } from "vitest";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  WORKSPACE,
  captureProjectUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const PUBLIC_PROJECT = {
  id: "site",
  displayName: "site",
  repositoryIdentity: "openclaw/site",
  source: "registered" as const,
};
const PRIVATE_PROJECT = {
  id: "openclaworg",
  displayName: "openclaworg",
  repositoryIdentity: "openclaw/openclaworg",
  source: "registered" as const,
};
// Restricted roles receive the Gateway's filtered projects.list response.
const ROLES = [
  {
    role: "writer",
    scopes: ["operator.read", "operator.write"],
    projects: [PUBLIC_PROJECT, PRIVATE_PROJECT],
  },
  { role: "guest", scopes: ["operator.sessions.write"], projects: [PUBLIC_PROJECT] },
] as const;

suite.define(() => {
  it("keeps project search text on the section-heading guide when focused on a phone", async () => {
    const page = await openPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await installMockGateway(page, {
      workspace: WORKSPACE,
      featureMethods: ["projects.list"],
      methodResponses: { "projects.list": { projects: [PUBLIC_PROJECT], recents: [] } },
    });
    await page.goto(`${suite.server.baseUrl}new?onboarding=1`);
    await page.locator("#new-session-project-trigger").tap();
    const picker = page.locator("#new-session-project-popover");
    const search = picker.getByRole("searchbox");
    await search.tap();
    for (const query of ["", "site"]) {
      await search.fill(query);
      await picker.getByRole("button", { name: /site/ }).first().waitFor();
      const heading = await picker.locator(".oc-menu-heading__label").first().boundingBox();
      const textStart = await search.evaluate((input) => {
        const style = getComputedStyle(input);
        return input.getBoundingClientRect().left + Number.parseFloat(style.paddingInlineStart);
      });
      expect(heading).not.toBeNull();
      expect(Math.abs(textStart - heading!.x)).toBeLessThanOrEqual(1);
      expect((await search.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }
  });

  it("tells a restricted role that no projects are shared with it", async () => {
    const page = await openPage();
    await installMockGateway(page, {
      workspace: WORKSPACE,
      operatorScopes: ["operator.sessions.write"],
      featureMethods: ["projects.list", "sessions.create"],
      methodResponses: { "projects.list": { projects: [], recents: [] } },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    await page.locator("#new-session-project-trigger").click();
    const picker = page.locator("#new-session-project-popover");
    await pollLocatorText(picker).toContain(
      "No projects are shared with your role. Ask an admin to share one.",
    );
    expect(await picker.getByRole("link", { name: "Manage projects" }).count()).toBe(0);
    await captureProjectUiProof(suite, page, "project-access-restricted-empty.png");
  });

  it.each(ROLES)(
    "restores and offers repositories the $role may open",
    async ({ role, scopes, projects }) => {
      const page = await openPage();
      await installMockGateway(page, {
        workspace: WORKSPACE,
        operatorScopes: [...scopes],
        // Saved New session preferences belong to the signed-in person.
        presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
        featureMethods: [
          "users.prefs.get",
          "users.prefs.set",
          "projects.list",
          "projects.searchRemote",
          "sessions.create",
        ],
        methodResponses: {
          "users.prefs.get": {
            status: "ok",
            entries: {
              "new-session.migration.v1": true,
              "new-session.v1:main": {
                workspace: WORKSPACE,
                folder: WORKSPACE,
                projectId: PRIVATE_PROJECT.id,
              },
            },
          },
          "users.prefs.set": { status: "ok" },
          "projects.list": { projects: [...projects], recents: [] },
          "projects.searchRemote": { credential: "configured", projects: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await pollLocatorText(trigger).toContain(
        role === "guest" ? WORKSPACE.split("/").pop()! : PRIVATE_PROJECT.repositoryIdentity,
      );
      if (role === "guest") {
        expect(await trigger.textContent()).not.toContain(PRIVATE_PROJECT.displayName);
      }
      await captureProjectUiProof(suite, page, `project-access-${role}-restored.png`);

      await trigger.click();
      const search = page.getByPlaceholder("Search projects or paste a Git URL");
      await search.fill("https://github.com/openclaw/openclaworg.git");
      const clone = page.getByText("https://github.com/openclaw/openclaworg.git", { exact: true });
      await expect.poll(() => clone.count()).toBe(role === "guest" ? 0 : 1);
      await captureProjectUiProof(suite, page, `project-access-${role}-paste-url.png`);
    },
  );
});
