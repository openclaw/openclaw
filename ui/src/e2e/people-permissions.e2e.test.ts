import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Locator } from "playwright";
import { expect, it } from "vitest";
import type { UserProfile } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = proof ? createControlUiE2eArtifactDir("people-permissions") : "";
const person: UserProfile = {
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
    modelPolicy: {
      sourceAgent: "main",
      allow: ["provider/allowed-*"],
      deny: ["provider/allowed-private"],
    },
    accessPolicyPlugin: "visitor-access",
  },
  maintainer: {
    sessions: { others: "write" },
    agents: "*",
    scopes: ["operator.read", "operator.write"],
  },
};
const profiles: UserProfile[] = [
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
      { viewport: { width: 1280, height: 1100 }, colorScheme: "dark" },
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
        await card.getByRole("link", { name: "View permissions", exact: true }).waitFor();
        await card.getByText("Saved role assignment: guest", { exact: true }).waitFor();
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
        await surface.getByText("Operator scope ceiling", { exact: true }).waitFor();
        await surface.getByText("provider/allowed-*", { exact: true }).waitFor();
        await surface.getByText("visitor-access", { exact: true }).waitFor();
        expect(
          await surface.getByRole("heading", { name: "This connection’s permissions" }).count(),
        ).toBe(0);
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

  it("keeps a guest self-scoped without directory or policy reads", async () => {
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
  it("updates canonical assignments on open sidebar and transcript cards, then retires lost access", async () => {
    await suite.withPage({}, async ({ page }) => {
      const setup = scenario();
      const gateway = await installMockGateway(page, {
        ...setup,
        historyMessages: [
          {
            role: "user",
            content: "@Alice",
            __openclaw: {
              id: "canonical-person-reference",
              humanMentions: [{ profileId: "alice", start: 0, end: 6 }],
            },
          },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page
        .locator(".sidebar-rail")
        .getByRole("button", { name: "Users", exact: true })
        .click();
      await page.locator('[data-online-user-id="alice"]').hover();
      const card = page.locator('.person-activity-hovercard[role="dialog"]');
      const saved = card.getByTitle("Saved role assignment", { exact: true });
      await expect.poll(() => saved.textContent()).toContain("guest");
      let canonical: UserProfile = {
        ...person,
        role: "release-staff",
        displayName: "Canonical Alice",
        updatedAt: 3,
      };
      await gateway.setMethodResponse("users.list", { profiles: [canonical, profiles[1]!] });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
      await expect.poll(() => saved.textContent()).toContain("release-staff");
      await card.getByRole("heading", { name: "Canonical Alice", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached" });
      await page.locator(".markdown-person-reference").focus();
      await expect.poll(() => saved.textContent()).toContain("release-staff");
      canonical = {
        ...canonical,
        role: undefined,
        effectiveRole: "maintainer",
        roleSource: "githubLogin",
        displayName: "Renamed Alice",
        updatedAt: 4,
      };
      await gateway.setMethodResponse("users.list", { profiles: [canonical, profiles[1]!] });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
      await expect.poll(() => saved.textContent()).toContain("No saved role");
      expect(await saved.textContent()).not.toContain("maintainer");
      await card.getByRole("heading", { name: "Renamed Alice", exact: true }).waitFor();
      const merged = {
        ...canonical,
        id: "alice-canonical",
        displayName: "Merged Alice",
        role: "guest",
      };
      await gateway.setMethodResponse("users.list", {
        profiles: [{ ...canonical, mergedInto: merged.id }, merged, profiles[1]!],
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
      await card.getByRole("heading", { name: "Merged Alice", exact: true }).waitFor();
      await expect.poll(() => saved.textContent()).toContain("guest");
      expect(
        await card
          .getByRole("link", { name: "View permissions", exact: true })
          .getAttribute("href"),
      ).toContain("person=alice-canonical");
      await gateway.setOperatorScopes(["operator.sessions.read"]);
      await gateway.closeLatest();
      await card.waitFor({ state: "detached" });
      expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
    });
  });

  it("shows a guest's own saved assignment without reading another person's profile or policy", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const setup = scenario();
      const gateway = await installMockGateway(page, {
        ...setup,
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
        presenceUsers: [
          {
            self: true,
            id: "alice",
            identity: { type: "profile", id: "alice" },
            name: "Alice",
            watchedSessions: [],
          },
          { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob", watchedSessions: [] },
        ],
        methodResponses: { ...setup.methodResponses, "users.self": { profile: person } },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page
        .locator(".sidebar-rail")
        .getByRole("button", { name: "Users", exact: true })
        .click();
      await page.locator('[data-online-user-id="alice"]').hover();
      const card = page.locator('.person-activity-hovercard[role="dialog"]');
      await card.getByText("Saved role assignment: guest", { exact: true }).waitFor();
      await card.getByRole("link", { name: "View permissions", exact: true }).waitFor();
      await capture(
        page,
        card,
        card.getByTitle("Saved role assignment"),
        "after-guest-self-card.png",
      );
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached" });
      await page.locator('[data-online-user-id="bob"]').hover();
      await card
        .getByText("Saved role assignment: Not available with your access", { exact: true })
        .waitFor();
      expect(await card.getByRole("link", { name: "View permissions", exact: true }).count()).toBe(
        0,
      );
      expect((await gateway.getRequests("users.self")).length).toBeGreaterThan(0);
      expect(await gateway.getRequests("users.list")).toHaveLength(0);
      expect(await gateway.getRequests("config.get")).toHaveLength(0);
      expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
    });
  });

  for (const mode of ["dark", "light"] as const) {
    it("preserves 24 long-name people, selected records and disclosure in " + mode, async () => {
      await suite.withPage(
        { viewport: { width: 1280, height: 1100 }, colorScheme: mode },
        async ({ page }) => {
          const role = "release-collaborator-" + "long-configured-role-".repeat(4);
          const agent = "shared-agent-" + "long-agent-label-".repeat(5);
          const people = Array.from({ length: 24 }, (_, index): UserProfile => ({
            ...person,
            id: "person-" + index,
            displayName:
              "Fictional collaborator " +
              index.toString().padStart(2, "0") +
              " — " +
              "LongName".repeat(13),
            role: index === 0 ? role : undefined,
            effectiveRole: role,
            roleSource: index === 0 ? "assigned" : "default",
          }));
          const setup = scenario();
          const gateway = await installMockGateway(page, {
            ...setup,
            methodResponses: {
              ...setup.methodResponses,
              "users.list": { profiles: people },
              "config.get": {
                exists: true,
                valid: true,
                config: {},
                sourceConfig: {},
                runtimeConfig: {
                  gateway: {
                    roles: {
                      default: role,
                      definitions: {
                        [role]: {
                          sessions: { others: "suggest" },
                          agents: [agent],
                          sandbox: "required",
                          scopes: ["operator.sessions.read"],
                          modelPolicy: {
                            sourceAgent: agent,
                            allow: ["synthetic-provider/long-model-family-*"],
                            deny: [],
                          },
                          accessPolicyPlugin: "visitor-access",
                        },
                        paused: {
                          sessions: { others: "none" },
                          agents: [],
                          scopes: [],
                          modelPolicy: { allow: [] },
                        },
                      },
                    },
                  },
                },
              },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/people?person=person-0");
          const surface = page.locator(".people-permissions");
          await surface.getByText("visitor-access", { exact: true }).waitFor();
          expect(await surface.locator(".settings-row--nav").count()).toBe(24);
          expect(
            await surface
              .getByRole("heading", { name: people[0]!.displayName!, exact: true })
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const details = surface.locator("details");
          expect(await details.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
          await capture(
            page,
            surface,
            surface.getByText("Operator scope ceiling", { exact: true }),
            "after-pressure-people-" + mode + ".png",
          );
          await details.locator("summary").click();
          const reads = (await gateway.getRequests("users.list")).length;
          const configs = (await gateway.getRequests("config.get")).length;
          await surface
            .getByRole("searchbox", { name: "Search people" })
            .fill("Fictional collaborator 23");
          await surface
            .getByRole("heading", { name: people[0]!.displayName!, exact: true })
            .waitFor();
          expect(await details.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
          await page.getByRole("button", { name: "Roles", exact: true }).click();
          await surface.getByRole("searchbox", { name: "Search roles" }).fill("paused");
          await surface.getByText(role, { exact: true }).waitFor();
          expect(await details.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
          expect((await gateway.getRequests("users.list")).length).toBe(reads);
          expect((await gateway.getRequests("config.get")).length).toBe(configs);
          await details.locator("summary").click();
          await surface.getByRole("searchbox", { name: "Search roles" }).fill("");
          await capture(
            page,
            surface,
            surface.getByText("Configured role", { exact: true }),
            "after-pressure-roles-" + mode + ".png",
          );
          if (mode === "light") {
            await page.setViewportSize({ width: 390, height: 844 });
            await surface
              .getByRole("heading", { name: "Configured role limits" })
              .scrollIntoViewIfNeeded();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await capture(
              page,
              surface,
              surface.getByRole("heading", { name: "Configured role limits" }),
              "after-pressure-phone.png",
            );
          }
          expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
        },
      );
    });
  }
});
