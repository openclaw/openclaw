import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { getInitialHistoryRequests } from "./chat-initial-history.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "sessions-navigation-identity" });
const targetKey = "agent:main:thread:12345678-aaaa-4000-8000-000000000001";
const targetText = "Selected target transcript 741";
const timestamp = Date.parse("2026-09-15T12:00:00.000Z");

async function requestParams(gateway: MockGatewayControls) {
  return (await getInitialHistoryRequests(gateway)).map((request) => request.params);
}
async function expectTargetOnly(gateway: MockGatewayControls, otherKey: string) {
  const params = await requestParams(gateway);
  expect(params).toContainEqual(expect.objectContaining({ key: targetKey }));
  expect(params).not.toContainEqual(expect.objectContaining({ key: otherKey }));
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
  source?: "table" | "href";
};
const scenarios: Scenario[] = [
  { name: "off-roster prefix collision" },
  { name: "cached-primary prefix collision", cached: true },
  { name: "off-roster cross-agent collision", otherAgent: "other" },
  { name: "ordinary table row", source: "table" },
  { name: "copied table link", source: "href" },
];

suite.define(() => {
  it.each(scenarios)("opens and reloads the selected session: $name", async (scenario) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const target = {
          ...session(targetKey, "target-generation", "Target launch review"),
          label: "Target launch review",
          boardFace: "chat",
        };
        const otherAgent = scenario.otherAgent ?? "main";
        const other = session(
          `agent:${otherAgent}:thread:12345678-bbbb-4000-8000-000000000002`,
          "other-generation",
          target.displayName,
        );
        const main = session("agent:main:main", "main-generation", "Home");
        const primary = scenario.cached ? [main, target, other] : [main];
        const searched = otherAgent === "main" ? [main, target, other] : [main, target];
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
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
          },
        });
        await page.goto(`${suite.server.baseUrl}sessions`);
        await page.getByRole("button", { name: "Search transcripts" }).click();
        const input = page.getByRole("searchbox", { name: "Search session transcripts" });
        await input.waitFor({ state: "visible" });
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
        const assertDestination = async () => {
          await page.getByText(targetText, { exact: true }).waitFor({ state: "visible" });
          expect(
            await page.getByRole("heading", { name: "Choose a session", exact: true }).isVisible(),
          ).toBe(false);
          await expect
            .poll(() => requestParams(gateway))
            .toContainEqual(expect.objectContaining({ key: targetKey }));
          await expectTargetOnly(gateway, other.key);
          expect(
            await page.getByText("Different synthetic transcript 982", { exact: true }).isVisible(),
          ).toBe(false);
        };
        await assertDestination();
        const beforeReloadRequests = await getInitialHistoryRequests(gateway);
        await page.reload();
        await assertDestination();
        const afterReloadRequests = await getInitialHistoryRequests(gateway);
        expect(
          afterReloadRequests.every((request) =>
            beforeReloadRequests.every((previous) => previous.id !== request.id),
          ),
        ).toBe(true);
      },
    );
  });
});
