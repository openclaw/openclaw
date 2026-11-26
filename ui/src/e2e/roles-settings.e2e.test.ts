import { writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI roles settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => "Playwright Chromium is unavailable at " + executablePath,
});

const pageOptions = {
  colorScheme: "dark",
  locale: "en-US",
  reducedMotion: "reduce",
  serviceWorkers: "block",
  viewport: { height: 1_000, width: 1_280 },
} as const;

const HASH = "roles-hash-1";

function rolesConfig() {
  return {
    gateway: {
      roles: {
        default: "operator",
        assignments: { byGithubLogin: { octocat: "collaborator" } },
        definitions: {
          administrator: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
          operator: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.read", "operator.write", "operator.approvals"],
          },
          collaborator: {
            sessions: { others: "invited", maxInvitedAccess: "send" },
            sandbox: "required",
            agents: ["main"],
            scopes: ["operator.sessions.read", "operator.sessions.write"],
          },
        },
      },
    },
  };
}

function profile(id: string, displayName: string, effectiveRole: string, roleSource: string) {
  return {
    id,
    displayName,
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [id + "@example.test"],
    githubIdentity: null,
    hasAvatar: false,
    ...(roleSource === "assigned" ? { role: effectiveRole } : {}),
    effectiveRole,
    roleSource,
  };
}

const PROFILES = [
  profile("p-ada", "Ada Admin", "administrator", "assigned"),
  profile("p-dev", "Dev Patel", "operator", "default"),
  profile("p-lena", "Lena Fischer", "operator", "default"),
  profile("p-maya", "Maya Chen", "collaborator", "assigned"),
  // Roles never apply to the gateway owner; the page neither counts nor lists it.
  profile("gateway-owner", "gateway-owner", "operator", "default"),
];

async function openRoles(
  page: Page,
  scopes?: string[],
  search = "",
  options: {
    config?: ReturnType<typeof rolesConfig>;
    selfProfileId?: string;
    usersList?: unknown;
  } = {},
) {
  const config = options.config ?? rolesConfig();
  const gateway = await installMockGateway(page, {
    featureMethods: ["config.patch", "users.setRole", "users.list"],
    ...(scopes ? { operatorScopes: scopes } : {}),
    ...(options.selfProfileId
      ? { presenceUsers: [{ id: options.selfProfileId, self: true }] }
      : {}),
    methodResponses: {
      "config.get": {
        ...configSnapshot(config, HASH),
        appliedConfigHash: HASH,
        sourceConfig: config,
      },
      "users.list": options.usersList ?? { profiles: PROFILES },
      "config.patch": { ok: true, config, hash: "roles-hash-2" },
    },
  });
  await page.goto(suite.server.baseUrl + "settings/roles" + search);
  return gateway;
}

async function proof(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    writeFileSync(
      path.join(suite.artifactDir, name + ".png"),
      await page.screenshot({ animations: "disabled" }),
    );
  }
}

suite.define(() => {
  it("lists roles under Settings → Team with the people who have each role", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await openRoles(page);
      const sidebar = page.locator(".settings-sidebar");
      await expect
        .poll(() => sidebar.getByText("Team", { exact: true }).count())
        .toBeGreaterThan(0);
      const collaborator = page.locator(".settings-row--nav").filter({ hasText: "collaborator" });
      await expect.poll(() => collaborator.textContent()).toContain("1 person");
      const operator = page.locator(".settings-row--nav").filter({ hasText: /^operator/ });
      await expect.poll(() => operator.first().textContent()).toContain("2 people");
      await expect.poll(() => page.getByText("1 logins").count()).toBe(1);
      await proof(page, "roles-list");
    });
  });

  it("saves an edited role with the loaded hash and confirmed array replacements", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page, undefined, "?role=collaborator");
      await page.getByText("What this role allows").waitFor();
      await expect.poll(() => page.getByText("Maya Chen").count()).toBeGreaterThan(0);
      await proof(page, "roles-editor");
      await page
        .locator("label.roles-scope")
        .filter({ hasText: "Approve agent actions" })
        .locator("input")
        .check();
      await page.getByRole("region", { name: "Unsaved changes" }).waitFor();
      await proof(page, "roles-editor-unsaved");
      const before = (await gateway.getRequests("config.patch")).length;
      await gateway.setMethodDelay("config.patch", 1500);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const saving = page.locator(".roles-savebar button[aria-busy='true']");
      await expect.poll(() => saving.textContent()).toContain("Saving…");
      expect(await saving.locator(".btn__spinner").count()).toBe(1);
      await expect
        .poll(async () => (await gateway.getRequests("config.patch")).length)
        .toBe(before + 1);
      const request = (await gateway.getRequests("config.patch"))[before];
      assert(request && isRecord(request.params) && typeof request.params.raw === "string");
      expect(request.params.baseHash).toBe(HASH);
      expect(request.params.replacePaths).toEqual(
        expect.arrayContaining([
          "gateway.roles.definitions.collaborator.agents",
          "gateway.roles.definitions.collaborator.scopes",
        ]),
      );
      const raw = JSON.parse(request.params.raw) as {
        gateway: { roles: { definitions: { collaborator: { scopes: string[] } } } };
      };
      expect(raw.gateway.roles.definitions.collaborator.scopes).toEqual([
        "operator.sessions.read",
        "operator.sessions.write",
        "operator.approvals",
      ]);
    });
  });

  it("drops an unsaved draft when another role opens", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await openRoles(page, undefined, "?role=collaborator");
      await page.getByText("What this role allows").waitFor();
      await page
        .locator("label.roles-scope")
        .filter({ hasText: "Approve agent actions" })
        .locator("input")
        .check();
      await page.getByRole("region", { name: "Unsaved changes" }).waitFor();
      await page.evaluate(() => {
        history.pushState(null, "", "/settings/roles?role=operator");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect
        .poll(() => page.locator(".content-header .page-title").textContent())
        .toBe("operator");
      await expect
        .poll(() => page.getByRole("region", { name: "Unsaved changes" }).count())
        .toBe(0);
    });
  });

  it("blocks saving a role that could not connect", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await openRoles(page, undefined, "?role=collaborator");
      await page.getByText("What this role allows").waitFor();
      for (const label of ["Read sessions they can access", "Work in sessions they can access"]) {
        await page
          .locator("label.roles-scope")
          .filter({ hasText: label })
          .locator("input")
          .uncheck();
      }
      await expect
        .poll(() => page.getByText("Choose at least one permission.", { exact: false }).count())
        .toBe(1);
      await expect
        .poll(() => page.getByRole("button", { name: "Save", exact: true }).isDisabled())
        .toBe(true);
      await proof(page, "roles-editor-invalid");
    });
  });

  it("assigns people to a role through users.setRole", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page, undefined, "?role=collaborator");
      await page.getByText("What this role allows").waitFor();
      await page.getByRole("button", { name: "Assign people" }).first().click();
      const dialog = page.locator(".roles-dialog");
      await dialog.getByText("Dev Patel").waitFor();
      await dialog
        .locator(".roles-picker__row")
        .filter({ hasText: "Dev Patel" })
        .locator("input")
        .check();
      await proof(page, "roles-assign");
      await dialog.getByRole("button", { name: "Assign 1" }).click();
      await expect.poll(async () => (await gateway.getRequests("users.setRole")).length).toBe(1);
      const [request] = await gateway.getRequests("users.setRole");
      expect(request?.params).toEqual({ profileId: "p-dev", role: "collaborator" });
    });
  });

  it("creates a role from a preset", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page);
      await page.getByRole("button", { name: "New role" }).click();
      const dialog = page.locator(".roles-dialog");
      await dialog.getByLabel("Role name").fill("Design Reviewers");
      await expect
        .poll(() => dialog.getByText("Use 1–64 lowercase", { exact: false }).count())
        .toBe(1);
      await dialog.getByLabel("Role name").fill("design-reviewers");
      await proof(page, "roles-create");
      await dialog.getByRole("button", { name: "Create role" }).click();
      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      const [request] = await gateway.getRequests("config.patch");
      assert(request && isRecord(request.params) && typeof request.params.raw === "string");
      const raw = JSON.parse(request.params.raw) as {
        gateway: { roles: { definitions: Record<string, unknown> } };
      };
      expect(Object.keys(raw.gateway.roles.definitions)).toEqual(["design-reviewers"]);
    });
  });

  it("keeps the person turning roles on as an administrator", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = rolesConfig();
      const { default: _default, ...roles } = config.gateway.roles;
      const gateway = await openRoles(page, undefined, "", {
        config: { gateway: { roles: roles as typeof config.gateway.roles } },
        selfProfileId: "p-dev",
      });
      await page.getByLabel("Role for people without one").selectOption("operator");
      const dialog = page.locator(".roles-dialog");
      const self = dialog.locator(".roles-picker__row").filter({ hasText: "Dev Patel" });
      await expect.poll(() => self.textContent()).toContain("You → administrator");
      expect(await self.locator("input").isChecked()).toBe(true);
      expect(await dialog.getByText("gateway-owner").count()).toBe(0);
      await proof(page, "roles-enable-default");
      const listed = (await gateway.getRequests("users.list")).length;
      // Hold the assignment so the in-progress state is observable.
      await gateway.setMethodDelay("users.setRole", 1500);
      await dialog.getByRole("button", { name: "Turn on roles" }).click();
      const busy = dialog.locator("button[aria-busy='true']");
      await expect.poll(() => busy.textContent()).toContain("Turning on roles…");
      expect(await busy.locator(".btn__spinner").count()).toBe(1);
      await expect.poll(() => dialog.count()).toBe(0);
      expect((await gateway.getRequests("config.patch")).length).toBe(1);
      // Who has each role is reloaded after the assignment and again after the default.
      await expect
        .poll(async () => (await gateway.getRequests("users.list")).length)
        .toBe(listed + 2);
      const [assigned] = await gateway.getRequests("users.setRole");
      expect(assigned?.params).toEqual({ profileId: "p-dev", role: "administrator" });
      const [request] = await gateway.getRequests("config.patch");
      assert(request && isRecord(request.params) && typeof request.params.raw === "string");
      expect(JSON.parse(request.params.raw)).toEqual({
        gateway: { roles: { default: "operator" } },
      });
    });
  });

  it("finishes turning roles on after assigning yourself closes your connection", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = rolesConfig();
      const { default: _default, ...roles } = config.gateway.roles;
      const gateway = await openRoles(page, undefined, "", {
        config: { gateway: { roles: roles as typeof config.gateway.roles } },
        selfProfileId: "p-dev",
      });
      await page.getByLabel("Role for people without one").selectOption("operator");
      const dialog = page.locator(".roles-dialog");
      await dialog.locator(".roles-picker__row").filter({ hasText: "Lena Fischer" }).click();
      await gateway.setMethodDelay("users.setRole", 1500);
      await dialog.getByRole("button", { name: "Turn on roles" }).click();
      // Others are assigned first; the Gateway closes your connection when your own role changes.
      await expect.poll(async () => (await gateway.getRequests("users.setRole")).length).toBe(2);
      const requests = await gateway.getRequests("users.setRole");
      expect(requests.map((request) => request.params)).toEqual([
        { profileId: "p-lena", role: "administrator" },
        { profileId: "p-dev", role: "administrator" },
      ]);
      await gateway.closeLatest(1008, "role changed");
      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      const [request] = await gateway.getRequests("config.patch");
      assert(request && isRecord(request.params) && typeof request.params.raw === "string");
      expect(JSON.parse(request.params.raw)).toEqual({
        gateway: { roles: { default: "operator" } },
      });
    });
  });

  it("reads the config again when a save is refused", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page, undefined, "?role=collaborator");
      await page.getByText("What this role allows").waitFor();
      await gateway.setMethodResponse("config.patch", {
        __mockError: { code: "INVALID_REQUEST", message: "config changed since last load" },
      });
      await page
        .locator("label.roles-scope")
        .filter({ hasText: "Approve agent actions" })
        .locator("input")
        .check();
      const reads = (await gateway.getRequests("config.get")).length;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(reads);
    });
  });

  it("moves saved assignments off a deleted role before roles are turned on", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = rolesConfig();
      const { default: _default, ...roles } = config.gateway.roles;
      const gateway = await openRoles(page, undefined, "?role=collaborator", {
        config: { gateway: { roles: roles as typeof config.gateway.roles } },
      });
      // Without a default role, a saved assignment is not yet anyone's effective role.
      await gateway.setMethodResponse("users.list", {
        profiles: [
          {
            ...profile("p-sam", "Sam Ortiz", "collaborator", "assigned"),
            effectiveRole: undefined,
            roleSource: undefined,
          },
        ],
      });
      await page.getByText("What this role allows").waitFor();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.locator(".roles-dialog");
      await dialog.getByRole("button", { name: "Move people and delete" }).click();
      await expect.poll(async () => (await gateway.getRequests("users.setRole")).length).toBe(1);
      const [moved] = await gateway.getRequests("users.setRole");
      expect(moved?.params).toEqual({ profileId: "p-sam", role: expect.any(String) });
    });
  });

  it("shows a refused default-role change", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page);
      await gateway.setMethodResponse("config.patch", {
        __mockError: { code: "INVALID_REQUEST", message: "default role refused" },
      });
      await page.getByLabel("Role for people without one").selectOption("collaborator");
      await page.getByRole("alert").filter({ hasText: "default role refused" }).waitFor();
    });
  });

  it("shows a failed people read with a retry instead of an empty roster", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page, undefined, "", {
        usersList: { __mockError: { code: "UNAVAILABLE", message: "directory down" } },
      });
      await page.getByText("Couldn’t load who has each role.", { exact: false }).waitFor();
      const before = (await gateway.getRequests("users.list")).length;
      await gateway.setMethodResponse("users.list", { profiles: PROFILES });
      await page.getByRole("button", { name: "Retry" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("users.list")).length)
        .toBeGreaterThan(before);
      const collaborator = page.locator(".settings-row--nav").filter({ hasText: "collaborator" });
      await expect.poll(() => collaborator.textContent()).toContain("1 person");
    });
  });

  it("deletes your own role only toward a role that keeps administrator access", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openRoles(page, undefined, "?role=administrator", {
        selfProfileId: "p-ada",
      });
      await page.getByText("What this role allows").waitFor();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.locator(".roles-dialog");
      await dialog.getByText("You have this role.", { exact: false }).waitFor();
      expect(
        await dialog.getByRole("button", { name: "Move people and delete" }).isDisabled(),
      ).toBe(true);
      expect(await gateway.getRequests("users.setRole")).toEqual([]);
    });
  });

  it("tells non-administrators that only administrators manage roles", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await openRoles(page, ["operator.read", "operator.write"]);
      await page.getByText("Only administrators can manage roles.").waitFor();
      await expect
        .poll(() => page.locator(".settings-sidebar").getByText("Team", { exact: true }).count())
        .toBe(0);
    });
  });
});
