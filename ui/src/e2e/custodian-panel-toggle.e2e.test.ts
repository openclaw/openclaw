import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import {
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { openDetailsPullRequests } from "./chat-details.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Ask OpenClaw panel toggle mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const MOCK_SESSION_ID = "e2e-custodian-panel";
const WORK_SESSION_KEY = "agent:main:work";
const chatMethods = ["chat.metadata", "chat.startup", "chat.history", "chat.send"];
const contextOptions = { colorScheme: "dark", ...createControlUiE2eContextOptions() } as const;

async function openHome(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, { sessionKey: WORK_SESSION_KEY, ...scenario });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY));
  await page.locator(".sidebar-footer-bar__home").click();
  return { gateway, panel: page.locator("openclaw-assistant-panel") };
}

const custodianScenario: ControlUiMockGatewayScenario = {
  sessionKey: WORK_SESSION_KEY,
  sessions: [{ key: WORK_SESSION_KEY, label: "Main", kind: "direct", updatedAt: Date.now() }],
  featureMethods: [...chatMethods, "openclaw.chat", "openclaw.chat.history"],
  methodResponses: {
    "sessions.list": {
      cases: [
        // The work session does not match the Ask OpenClaw palette query.
        {
          match: { search: "Ask OpenClaw" },
          response: { count: 0, sessions: [] },
        },
      ],
    },
    "openclaw.chat": {
      sessionId: MOCK_SESSION_ID,
      reply: "Machine is healthy. Ask me anything.",
      action: "none",
    },
    "openclaw.chat.history": {
      turns: [{ role: "assistant", text: "Channel repaired.", at: 1_700_000_101_000 }],
    },
  },
};

suite.define(() => {
  it.each(["saved", "live"] as const)(
    "keeps PRs and %s task progress in full-page Details, not above the Home composer",
    async (progress) => {
      await suite.withPage({ ...contextOptions, reducedMotion: "reduce" }, async ({ page }) => {
        const homeKey = "agent:main:main";
        const active = progress === "live";
        const transcript =
          "I finished checking the release notes. The changes are ready for review.";
        const { gateway, panel } = await openHome(page, {
          featureMethods: [
            ...chatMethods,
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          sessions: [
            { key: WORK_SESSION_KEY, kind: "direct", label: "Release notes", updatedAt: 2 },
            {
              key: homeKey,
              kind: "main",
              label: "Home",
              updatedAt: 1,
              hasActiveRun: active,
              activeRunIds: active ? ["home-release-notes"] : [],
            },
          ],
          sessionTranscripts: {
            [homeKey]: {
              messages: [
                { role: "user", content: "Could you check the release notes?" },
                { role: "assistant", content: transcript },
              ],
            },
          },
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": {
              cases: [
                {
                  match: { sessionKey: homeKey },
                  response: {
                    card: {
                      sessionKey: homeKey,
                      revision: 1,
                      updatedAt: active ? Date.now() : Date.now() - 2 * 86_400_000,
                      markdown: "Checked the release notes and opened the changes for review.",
                    },
                  },
                },
              ],
              fallback: { card: null },
            },
          },
        });
        const home = panel.locator("openclaw-home-session");
        const reply = home.getByText(transcript, { exact: true });
        const composer = home.getByRole("textbox", { name: "Chat composer", exact: true });
        await reply.waitFor();
        await composer.fill("Thanks. What should we check next?");
        await waitForWatchedSessionKey(gateway, homeKey);
        const pullRequest = {
          number: 42,
          owner: "example",
          repo: "release-notes",
          branch: "fix/release-notes",
          title: "Clarify the release notes",
          url: "https://github.com/example/release-notes/pull/42",
          state: "open",
        };
        const emitPullRequest = () =>
          gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [homeKey]: { pullRequests: [pullRequest], rateLimited: false, status: "ready" },
            },
          });
        await emitPullRequest();
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).map((r) => r.params))
          .toContainEqual({ sessionKey: homeKey });
        expect(await home.locator(".chat-prs, .agent-chat__progress-float").count()).toBe(0);

        await panel.getByRole("button", { name: "Open Home full page", exact: true }).click();
        await home.waitFor({ state: "hidden" });
        await page.getByText(transcript, { exact: true }).waitFor();
        // The mock acknowledges subscriptions but does not send the initial snapshot.
        await waitForWatchedSessionKey(gateway, homeKey);
        await emitPullRequest();
        const details = await openDetailsPullRequests(page);
        await details.getByRole("link", { name: /Clarify the release notes/ }).waitFor();
        await page.locator('[data-progress-card-placement="details"]').waitFor();
        expect(
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).inputValue(),
        ).toBe("Thanks. What should we check next?");
      });
    },
  );

  it("keeps Home available without an OpenClaw tab when openclaw.chat is not advertised", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, panel } = await openHome(page, { featureMethods: chatMethods });
      await panel.getByRole("button", { name: "Home", exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    });
  });

  it("opens the same OpenClaw conversation from Home and the palette", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const { panel } = await openHome(page, custodianScenario);
      const openClawTab = panel.getByRole("button", { name: "Ask OpenClaw", exact: true });
      await openClawTab.click();
      await panel.getByText("Channel repaired.").waitFor();

      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await panel.getByText("Channel repaired.").waitFor({ state: "hidden" });

      await page.locator(".sidebar-brand__search").click();
      await page
        .locator("openclaw-command-palette")
        .getByPlaceholder("Search…")
        .fill("Ask OpenClaw");
      const paletteItem = page.getByRole("option", { name: "Ask OpenClaw", exact: true });
      await paletteItem.click();
      await panel.getByText("Channel repaired.").waitFor();
    });
  });
});
