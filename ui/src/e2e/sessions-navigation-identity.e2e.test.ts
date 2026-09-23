import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "sessions-navigation-identity" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const targetKey = "agent:main:thread:12345678-aaaa-4000-8000-000000000001";
const targetText = "Selected target transcript 741";
const timestamp = Date.parse("2026-09-15T12:00:00.000Z");

async function primaryKeys(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: ApplicationContext };
    };
    return app.runtime?.context.sessions.state.result?.sessions.map((row) => row.key) ?? null;
  });
}
async function capture(page: Page, name: string) {
  if (captureProof) {
    await page.screenshot({ path: path.join(suite.artifactDir, name), fullPage: true });
  }
}

type Scenario = {
  name: string;
  cached?: boolean;
  otherAgent?: string;
  otherPrefix?: string;
  sameTitle?: boolean;
  source?: "table" | "href";
  face?: "dashboard";
};
const scenarios: Scenario[] = [
  { name: "off-roster prefix collision" },
  { name: "cached-primary prefix collision", cached: true },
  { name: "off-roster different prefix", otherPrefix: "87654321" },
  { name: "off-roster cross-agent collision", otherAgent: "other" },
  { name: "same-title prefix collision", sameTitle: true },
  { name: "ordinary table row", sameTitle: true, source: "table" },
  { name: "copied table link", sameTitle: true, source: "href" },
  { name: "cached same-title copied table link", cached: true, sameTitle: true, source: "href" },
  { name: "saved dashboard face", sameTitle: true, face: "dashboard" },
];

suite.define(() => {
  it.each(scenarios)("opens and reloads the selected session: $name", async (scenario) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const target = {
          key: targetKey,
          sessionId: "target-generation",
          kind: "direct",
          displayName: "Target launch review",
          label: "Target launch review",
          boardFace: scenario.face ?? "chat",
          updatedAt: timestamp,
        };
        const otherAgent = scenario.otherAgent ?? "main";
        const other = {
          key: `agent:${otherAgent}:thread:${scenario.otherPrefix ?? "12345678"}-bbbb-4000-8000-000000000002`,
          sessionId: "other-generation",
          kind: "direct",
          displayName: scenario.sameTitle ? target.displayName : "Other release review",
          updatedAt: timestamp,
        };
        const main = {
          key: "agent:main:main",
          sessionId: "main-generation",
          kind: "direct",
          displayName: "Home",
          updatedAt: timestamp,
        };
        const result = (sessions: (typeof main)[]) => ({
          sessions,
          count: sessions.length,
          totalCount: sessions.length,
          hasMore: false,
          offset: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          ts: timestamp,
        });
        const primary = scenario.cached ? [main, target, other] : [main];
        const searched = otherAgent === "main" ? [main, target, other] : [main, target];
        const gateway = await installMockGateway(page, {
          featureMethods: ["board.get", "chat.metadata", "chat.startup", "sessions.search"],
          // Stored rows own resolution independently of the bounded sidebar and table responses.
          sessions: [main, target, other],
          sessionKey: main.key,
          sessionTranscripts: {
            [target.key]: {
              messages: [
                { role: "assistant", content: [{ type: "text", text: targetText }], timestamp },
              ],
            },
            [other.key]: {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "Different synthetic transcript 982" }],
                  timestamp,
                },
              ],
            },
          },
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: { limit: 50 }, response: result(scenario.source ? searched : primary) },
                { response: result(primary) },
              ],
            },
            "sessions.search": {
              sessions: [target],
              results: [
                {
                  messageId: "target-message",
                  role: "assistant",
                  score: 1,
                  sessionId: target.sessionId,
                  sessionKey: target.key,
                  snippet: targetText,
                  timestamp,
                },
              ],
            },
            "board.get": {
              cases: [
                {
                  match: { sessionKey: targetKey },
                  response: {
                    sessionKey: targetKey,
                    revision: 1,
                    tabs: [
                      { tabId: "main", title: "Target overview", position: 0, chatDock: "right" },
                    ],
                    widgets: [],
                  },
                },
                { response: null },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}sessions`);
        const input = page.getByRole("searchbox", { name: "Search session transcripts" });
        await input.waitFor({ state: "visible" });
        await expect.poll(() => primaryKeys(page)).not.toBeNull();
        if (!scenario.source) {
          await input.fill("Selected target transcript");
          await input.press("Enter");
        }
        const selected = scenario.source
          ? page
              .locator(".session-data-row")
              .filter({
                has: page.getByRole("checkbox", {
                  name: `Select session: ${targetKey}`,
                  exact: true,
                }),
              })
              .locator(".session-link")
          : page.locator(".sessions-transcript-search__result");
        await selected.waitFor({ state: "visible" });
        const primaryBeforeClick = await primaryKeys(page);
        expect(primaryBeforeClick?.includes(targetKey)).toBe(scenario.cached === true);
        const searchRequests = await gateway.getRequests("sessions.search");
        expect(searchRequests).toHaveLength(scenario.source ? 0 : 1);
        if (!scenario.source) {
          expect(searchRequests[0]?.params).toMatchObject({
            query: "Selected target transcript",
            limit: 25,
            scope: { agentId: "main" },
          });
        }
        await capture(page, "before-click.png");
        if (scenario.source === "href") {
          const href = await selected.getAttribute("href");
          expect(href).toBeTruthy();
          await page.goto(new URL(href!, page.url()).href);
        } else {
          await selected.click();
        }
        const visibleDestination = page
          .locator("openclaw-chat-page, #control-ui-main h2")
          .filter({ has: page.locator("openclaw-board-view") })
          .or(page.getByText(targetText, { exact: true }))
          .or(page.getByRole("heading", { name: "Choose a session", exact: true }));
        await visibleDestination.first().waitFor({ state: "visible" });
        await capture(page, "after-click.png");
        if (captureProof) {
          await writeFile(
            path.join(suite.artifactDir, "receipt.json"),
            JSON.stringify(
              {
                scenario,
                primaryBeforeClick,
                searchRequests,
                url: page.url(),
                resolveRequests: await gateway.getRequests("sessions.resolve"),
                startupRequests: await gateway.getRequests("chat.startup"),
              },
              null,
              2,
            ),
          );
        }
        expect(
          await page.getByRole("heading", { name: "Choose a session", exact: true }).isVisible(),
        ).toBe(false);
        const assertDestination = async () => {
          if (scenario.face) {
            await page.locator("openclaw-board-view").waitFor({ state: "visible" });
            expect(new URL(page.url()).pathname.startsWith("/dashboard/main/")).toBe(true);
          } else {
            await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
          }
          await expect
            .poll(async () =>
              (await gateway.getRequests("chat.startup")).map((request) => request.params),
            )
            .toContainEqual(expect.objectContaining({ sessionKey: targetKey }));
          expect(
            (await gateway.getRequests("chat.startup")).map((request) => request.params),
          ).not.toContainEqual(expect.objectContaining({ sessionKey: other.key }));
          expect(
            await page.getByText("Different synthetic transcript 982", { exact: true }).isVisible(),
          ).toBe(false);
          if (scenario.face) {
            expect(
              (await gateway.getRequests("board.get")).map((request) => request.params),
            ).toContainEqual(expect.objectContaining({ sessionKey: targetKey }));
            expect(
              (await gateway.getRequests("board.get")).map((request) => request.params),
            ).not.toContainEqual(expect.objectContaining({ sessionKey: other.key }));
          }
        };
        await assertDestination();
        const beforeReloadRequests = await gateway.getRequests("chat.startup");
        await page.reload();
        await assertDestination();
        const afterReloadRequests = await gateway.getRequests("chat.startup");
        expect(
          afterReloadRequests.every((request) =>
            beforeReloadRequests.every((previous) => previous.id !== request.id),
          ),
        ).toBe(true);
        await capture(page, "after-reload.png");
        if (captureProof) {
          await writeFile(
            path.join(suite.artifactDir, "reload-receipt.json"),
            JSON.stringify(
              {
                scenario,
                url: page.url(),
                beforeReloadRequests,
                afterReloadRequests,
                boardRequests: await gateway.getRequests("board.get"),
              },
              null,
              2,
            ),
          );
        }
      },
    );
  });
});
