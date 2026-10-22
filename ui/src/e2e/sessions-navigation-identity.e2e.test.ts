import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "sessions-navigation-identity" });
const targetKey = "agent:main:thread:12345678-aaaa-4000-8000-000000000001";
const targetText = "Selected target transcript 741";
const timestamp = Date.parse("2026-09-15T12:00:00.000Z");

async function primaryKeys(page: Page) {
  return evaluateControlUiContext(
    page,
    (context) => context.sessions.state.result?.sessions.map((row) => row.key) ?? null,
  );
}
async function requestParams(gateway: MockGatewayControls, method: string) {
  return (await gateway.getRequests(method)).map((request) => request.params);
}
async function expectTargetOnly(gateway: MockGatewayControls, method: string, otherKey: string) {
  const params = await requestParams(gateway, method);
  expect(params).toContainEqual(expect.objectContaining({ sessionKey: targetKey }));
  expect(params).not.toContainEqual(expect.objectContaining({ sessionKey: otherKey }));
}
function session(key: string, sessionId: string, displayName: string) {
  return { key, sessionId, displayName, kind: "direct", updatedAt: timestamp };
}
function transcript(text: string) {
  return { messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp }] };
}
function result(sessions: ReturnType<typeof session>[]) {
  return {
    sessions,
    count: sessions.length,
    totalCount: sessions.length,
    hasMore: false,
    offset: 0,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    ts: timestamp,
  };
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
          ...session(targetKey, "target-generation", "Target launch review"),
          label: "Target launch review",
          boardFace: scenario.face ?? "chat",
        };
        const otherAgent = scenario.otherAgent ?? "main";
        const other = session(
          `agent:${otherAgent}:thread:${scenario.otherPrefix ?? "12345678"}-bbbb-4000-8000-000000000002`,
          "other-generation",
          scenario.sameTitle ? target.displayName : "Other release review",
        );
        const main = session("agent:main:main", "main-generation", "Home");
        const primary = scenario.cached ? [main, target, other] : [main];
        const searched = otherAgent === "main" ? [main, target, other] : [main, target];
        const gateway = await installMockGateway(page, {
          featureMethods: ["board.get", "chat.metadata", "chat.startup", "sessions.search"],
          // Stored rows own resolution independently of the bounded sidebar and table responses.
          sessions: [main, target, other],
          sessionKey: main.key,
          sessionTranscripts: {
            [target.key]: transcript(targetText),
            [other.key]: transcript("Different synthetic transcript 982"),
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
        await page.getByRole("button", { name: "Search transcripts" }).click();
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
            .poll(() => requestParams(gateway, "chat.startup"))
            .toContainEqual(expect.objectContaining({ sessionKey: targetKey }));
          await expectTargetOnly(gateway, "chat.startup", other.key);
          expect(
            await page.getByText("Different synthetic transcript 982", { exact: true }).isVisible(),
          ).toBe(false);
          if (scenario.face) {
            await expectTargetOnly(gateway, "board.get", other.key);
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
      },
    );
  });
});
