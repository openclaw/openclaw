import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent GitHub accounts",
  startServerBeforeBrowser: true,
});

const agents = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Main" },
    { id: "pr-irrigator", name: "PR Irrigator" },
    { id: "release-notes", name: "Release Notes" },
  ],
};
const configWith = (ownAccounts: readonly string[], sharedAuthor = "Shared") => {
  const config = {
    tools: { github: { mode: "managed", gitAuthor: { name: sharedAuthor } } },
    agents: {
      entries: Object.fromEntries(
        ownAccounts.map((id) => [id, { tools: { github: { mode: "managed" } } }]),
      ),
    },
  };
  return {
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    runtimeConfig: config,
    hash: `github-accounts-${ownAccounts.join("-")}`,
  };
};

/** The Gateway owns which agents carry their own account; this mock keeps that fact in the page. */
async function installGitHubAccounts(page: Page) {
  // Runs after the mock Gateway's own init script, before the app's first request.
  await page.addInitScript(() => {
    const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
    const facts = (login: string, source: string, credentialKind: string) => ({
      source,
      credentialKind,
      credentialState: "available",
      account: { login },
      gitAuthor: { name: null, email: null },
      evidence: "github-api",
      accessExpiresAtMs: null,
      refreshState: "not_applicable",
      oauthScopes: [],
      repositoryGrants: "unknown",
    });
    let shared = facts("shared-octocat", "system-configured", "managed-pat");
    const own = new Map<string, ReturnType<typeof facts>>([
      ["release-notes", facts("release-bot", "agent-override", "managed-pat")],
    ]);
    const status = (agentId: string, selectedScope: "system" | "agent") => {
      const override = own.get(agentId);
      const selected = selectedScope === "system" ? shared : (override ?? null);
      return {
        agentId,
        selectedScope,
        selected: { scope: selectedScope, configured: selected !== null, identity: selected },
        effective: override ?? shared,
      };
    };
    type Request = { params: unknown; respond: (response: unknown) => void };
    const read = (params: unknown) => params as Record<string, string>;
    mock.setRequestHandler("tools.github.status", ({ params, respond }: Request) => {
      const { agentId, selectedScope } = read(params);
      respond(status(agentId!, selectedScope === "agent" ? "agent" : "system"));
    });
    mock.setRequestHandler("tools.github.configure", ({ params, respond }: Request) => {
      const { agentId, scope, mode } = read(params);
      if (scope === "agent" && mode === "managed") {
        own.set(agentId!, facts("fork-only-bot", "agent-override", "managed-pat"));
      } else if (scope === "agent") {
        own.delete(agentId!);
      } else if (mode === "managed") {
        shared = facts("new-shared-octocat", "system-configured", "managed-pat");
      }
      respond(status(agentId!, scope === "agent" ? "agent" : "system"));
    });
  });
}

suite.define(() => {
  it("gives one agent its own GitHub account and returns it to the shared account", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 2200, width: 1100 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin"],
          presenceUsers: [
            { self: true, id: "11111111-1111-4111-8111-111111111111", name: "Test Person" },
          ],
          methodResponses: {
            "agents.list": agents,
            "config.get": configWith(["release-notes"]),
            "secrets.store.set": { ok: true },
            "users.github.status": {
              personal: {
                state: "connected",
                generation: "22222222-2222-4222-8222-222222222222",
                account: { accountId: 2, login: "personal-octocat" },
                accessExpiresAtMs: 1_900_000_000_000,
                refreshState: "available",
                pending: null,
              },
              system: null,
            },
          },
        });
        await installGitHubAccounts(page);
        await page.goto(`${suite.server.baseUrl}settings/profile`);
        const section = page.locator("#settings-profile-github-connections");
        const agent = (id: string) => section.locator(`[data-agent-id="${id}"]`);
        const button = (name: string) => section.getByRole("button", { name, exact: true });
        const artifacts = createControlUiE2eArtifactDir("github-accounts-agents");
        const capture = async (name: string, content: ReturnType<Page["locator"]>[]) => {
          const frame = await takeControlUiScreenshotFrame(page, section, content, {
            elements: [section],
            animations: "disabled",
          });
          writeFileSync(path.join(artifacts, name), frame.elements[0]!.png);
        };

        await expect(section.locator('[data-github-connection="personal"]')).toContainText(
          "@personal-octocat",
        );
        await expect(section.locator('[data-github-connection="system"]')).toContainText(
          "@shared-octocat",
        );
        await expect(button("Change shared agent account")).toHaveText("Change for 2 agents");
        await expect(agent("main")).toContainText("Uses the shared agent account");
        await expect(agent("pr-irrigator")).toContainText("@shared-octocat");
        await expect(agent("release-notes")).toContainText("@release-bot");
        await expect(agent("release-notes")).toContainText("Own account · Personal access token");
        await capture("1-github-accounts.png", [agent("release-notes")]);

        await button("Give PR Irrigator its own GitHub account").click();
        const setup = agent("pr-irrigator").locator("[data-github-setup]");
        await expect(setup).toContainText("Only PR Irrigator changes.");
        await setup.getByRole("button", { name: "Use a PAT instead", exact: true }).click();
        await setup.getByLabel("Fine-grained PAT", { exact: true }).fill("synthetic-fork-only-pat");
        await setup
          .getByLabel("Commit author name (optional)", { exact: true })
          .fill("PR Irrigator");
        await capture("2-give-agent-own-account.png", [
          setup.getByRole("button", { name: "Save for PR Irrigator", exact: true }),
        ]);

        await gateway.setMethodResponse(
          "config.get",
          configWith(["release-notes", "pr-irrigator"]),
        );
        await setup.getByRole("button", { name: "Save for PR Irrigator", exact: true }).click();
        expect((await gateway.waitForRequest("tools.github.configure")).params).toMatchObject({
          scope: "agent",
          agentId: "pr-irrigator",
          mode: "managed",
          gitAuthor: { name: "PR Irrigator" },
        });
        await expect(agent("pr-irrigator")).toContainText("@fork-only-bot");
        await expect(agent("pr-irrigator")).toContainText("Own account");
        await expect(agent("main")).toContainText("@shared-octocat");
        await expect(section.locator('[data-github-connection="system"]')).toContainText(
          "@shared-octocat",
        );
        await expect(button("Change shared agent account")).toHaveText("Change for 1 agent");
        await agent("pr-irrigator").getByRole("button", { name: "Close", exact: true }).click();
        await expect(agent("pr-irrigator").locator("[data-github-setup]")).toHaveCount(0);
        await capture("3-agent-has-own-account.png", [agent("pr-irrigator")]);

        await gateway.setMethodResponse("config.get", configWith(["release-notes"]));
        await button("Use the shared agent account for PR Irrigator").click();
        await page.getByRole("button", { name: "Use shared account", exact: true }).last().click();
        await expect(agent("pr-irrigator")).toContainText("Uses the shared agent account");
        await expect(agent("pr-irrigator")).toContainText("@shared-octocat");

        // A shared change reaches agents that inherit it; agents with their own account keep it.
        await gateway.setMethodResponse("config.get", configWith(["release-notes"], "New shared"));
        await button("Change shared agent account").click();
        const sharedSetup = section.locator(
          '[data-github-connection="system"] [data-github-setup]',
        );
        await expect(sharedSetup).toContainText("including their dashboard data and Publish PR");
        await expect(sharedSetup).toContainText("Agents with their own account keep it.");
        await sharedSetup.getByRole("button", { name: "Use a PAT instead", exact: true }).click();
        await sharedSetup
          .getByLabel("Fine-grained PAT", { exact: true })
          .fill("synthetic-shared-pat");
        await sharedSetup.getByRole("button", { name: "Save account", exact: true }).click();
        await expect(agent("main")).toContainText("@new-shared-octocat");
        await expect(agent("pr-irrigator")).toContainText("@new-shared-octocat");
        await expect(agent("release-notes")).toContainText("@release-bot");
        const configures = await gateway.getRequests("tools.github.configure");
        expect(configures.map(({ params }) => params)).toEqual([
          expect.objectContaining({ scope: "agent", agentId: "pr-irrigator", mode: "managed" }),
          { scope: "agent", agentId: "pr-irrigator", mode: "inherit" },
          expect.objectContaining({ scope: "system", mode: "managed" }),
        ]);
      },
    );
  });
});
