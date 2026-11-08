import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const before = process.env.OPENCLAW_PERMISSION_BEFORE === "1";
const proof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = proof ? createControlUiE2eArtifactDir("people-permissions") : "";
const person = {
  id: "alice",
  displayName: "Alice",
  role: "guest",
  effectiveRole: "guest",
  roleSource: "assigned",
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
};
const definitions = {
  guest: {
    sessions: { others: "view" },
    agents: ["main"],
    sandbox: "required",
    scopes: ["operator.sessions.read", "operator.sessions.write"],
  },
  maintainer: {
    sessions: { others: "write" },
    agents: "*",
    scopes: ["operator.read", "operator.write"],
  },
};
const profiles = [
  person,
  {
    ...person,
    id: "bob",
    displayName: "Bob",
    role: undefined,
    effectiveRole: "maintainer",
    roleSource: "githubLogin",
  },
];
function scenario() {
  return {
    featureMethods: [...new Set([...defaultControlUiFeatureMethods, "users.list", "config.get"])],
    presenceUsers: [
      {
        id: "alice",
        identity: { type: "profile" as const, id: "alice" },
        name: "Alice",
        watchedSessions: [],
      },
    ],
    methodResponses: {
      "users.list": { profiles },
      "config.get": {
        exists: true,
        valid: true,
        config: {},
        sourceConfig: {},
        runtimeConfig: { gateway: { roles: { default: "guest", definitions } } },
      },
    },
  };
}
async function capture(page: Page, surface: Locator, content: Locator, name: string) {
  if (!proof) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, surface, [content], {
    animations: "disabled",
    elements: name.endsWith("card.png") ? [surface] : [],
  });
  await writeFile(path.join(artifactDir, name), frame.png);
  if (name.endsWith("card.png")) {
    await writeFile(
      path.join(artifactDir, name.replace(".png", "-detail.png")),
      frame.elements[0]!.png,
    );
  }
}

suite.define(() => {
  it("opens permission limits from a person without confusing saved roles with grants", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        await page.goto(suite.server.baseUrl + "chat");
        await page
          .locator(".sidebar-rail")
          .getByRole("button", { name: "Users", exact: true })
          .click();
        await page.locator('[data-online-user-id="alice"]').hover();
        const card = page.getByRole("dialog", { name: "Activity for Alice", exact: true });
        await card.getByRole("heading", { name: "Alice", exact: true }).waitFor();
        if (before) {
          expect(
            await card.getByRole("link", { name: "View permissions", exact: true }).count(),
          ).toBe(0);
          await capture(
            page,
            card,
            card.getByRole("heading", { name: "Alice", exact: true }),
            "before-card.png",
          );
          return;
        }
        await card.getByRole("link", { name: "View permissions", exact: true }).waitFor();
        await capture(
          page,
          card,
          card.getByRole("heading", { name: "Alice", exact: true }),
          "after-card.png",
        );
        await card.getByRole("link", { name: "View permissions", exact: true }).click();
        const surface = page.locator(".people-permissions");
        await surface.getByText("Required", { exact: true }).waitFor();
        expect(page.url()).toContain("settings/people?person=alice");
        expect(await surface.textContent()).toContain("Maximums, not live permissions.");
        await capture(
          page,
          surface,
          surface.getByText("Required", { exact: true }),
          "after-people.png",
        );
        const reads = (await gateway.getRequests("users.list")).length;
        await surface.getByRole("searchbox", { name: "Search people" }).fill("Bob");
        expect(await surface.getByText("Alice", { exact: true }).count()).toBe(1);
        expect((await gateway.getRequests("users.list")).length).toBe(reads);
        await page.getByRole("button", { name: "Roles", exact: true }).click();
        await surface.getByRole("button", { name: /maintainer/ }).click();
        await surface.getByText("GitHub login mapping", { exact: true }).waitFor();
        await capture(
          page,
          surface,
          surface.getByText("GitHub login mapping", { exact: true }),
          "after-roles.png",
        );
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          390,
        );
        await capture(
          page,
          surface,
          surface.getByRole("heading", { name: "Configured role limits" }),
          "after-phone.png",
        );
        expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
      },
    );
  });

  it.skipIf(before)("keeps a guest self-scoped without directory or policy reads", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...scenario(),
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
      });
      await page.goto(suite.server.baseUrl + "settings/people?person=alice");
      const surface = page.locator(".people-permissions");
      await surface
        .getByText("This profile is unavailable or cannot be read with your current access.", {
          exact: true,
        })
        .waitFor();
      expect(await gateway.getRequests("users.list")).toHaveLength(0);
      expect(await gateway.getRequests("config.get")).toHaveLength(0);
      await surface
        .getByRole("button", { name: "This connection’s permissions", exact: true })
        .click();
      await surface
        .getByText("operator.sessions.read, operator.sessions.write", { exact: true })
        .waitFor();
      await capture(
        page,
        surface,
        surface.getByText("operator.sessions.read, operator.sessions.write", { exact: true }),
        "after-guest.png",
      );
      expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
    });
  });
});
