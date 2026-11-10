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
      if ((await search.count()) === 0) {
        await page.locator(".header-search__toggle").click();
      }
      await search.fill("https://github.com/openclaw/openclaworg.git");
      const clone = page.getByText("https://github.com/openclaw/openclaworg.git", { exact: true });
      await expect.poll(() => clone.count()).toBe(role === "guest" ? 0 : 1);
      await captureProjectUiProof(suite, page, `project-access-${role}-paste-url.png`);
    },
  );
});
