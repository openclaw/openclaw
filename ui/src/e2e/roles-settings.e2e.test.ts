import { writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
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
];

async function openRoles(page: Page, scopes?: string[], search = "") {
  const config = rolesConfig();
  const gateway = await installMockGateway(page, {
    featureMethods: ["config.patch", "users.setRole", "users.list"],
    ...(scopes ? { operatorScopes: scopes } : {}),
    methodResponses: {
      "config.get": {
        ...configSnapshot(config, HASH),
        appliedConfigHash: HASH,
        sourceConfig: config,
      },
      "users.list": { profiles: PROFILES },
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
      await page.getByRole("button", { name: "Save", exact: true }).click();
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

  it("links each Remote access member to their role", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installNativePluginMockGateway(page, {
        nativePlugins: [
          {
            pluginId: "openclaw-id-access",
            rootDir: path.resolve("extensions/openclaw-id-access"),
            source: "./browser/index.tsx",
          },
        ],
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        methodResponses: {
          "openclawId.status": {
            status: { state: "on" },
            owner: true,
            channel: "local_operator",
            link: { linked: true },
          },
          "openclawId.people": { link: { linked: true } },
        },
      });
      await page.goto(suite.server.baseUrl + "plugin?plugin=openclaw-id-access&id=access");
      await page.locator(".ocid-access").waitFor();
      await gateway.setMethodResponse("openclawId.people", {
        link: {
          linked: true,
          clawId: "synthetic-claw",
          ownerDevices: [],
          roles: [
            {
              name: "operator",
              defined: true,
              sessions: "write",
              requiresSandbox: false,
              admin: false,
            },
            {
              name: "collaborator",
              defined: true,
              sessions: "invited",
              maxInvitedAccess: "send",
              requiresSandbox: true,
              admin: false,
            },
          ],
          members: [
            {
              accountId: "m-maya",
              displayName: "Maya Chen",
              role: "collaborator",
              roleDefined: true,
              peerKeys: [],
              email: "maya@example.test",
            },
          ],
          invites: [],
          nodes: [],
        },
      });
      await gateway.emitGatewayEvent("openclawId.people.changed");
      const link = page
        .locator(".ocid-access__row--member")
        .getByRole("link", { name: "Open role" });
      await link.waitFor();
      expect(
        new URL(await link.evaluate((node) => (node as HTMLAnchorElement).href)).pathname +
          new URL(await link.evaluate((node) => (node as HTMLAnchorElement).href)).search,
      ).toBe("/settings/roles?role=collaborator");
      await proof(page, "remote-access-role-link");
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
