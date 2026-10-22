import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette avatars" });
const avatarSvg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${fill}"/></svg>`;
const owner = {
  type: "human" as const,
  id: "profile-alex",
  identity: { type: "profile" as const, id: "profile-alex" },
  label: "Alex Rivera",
  avatarUrl: "/api/users/profile-alex/avatar?v=1",
};
const rows = (
  [
    ["agent:main:search-design", "Missing errors in the conversation", 240_000],
    ["agent:main:worker", "Post-migration worker launch failure", 7_200_000],
    ["agent:reviewer:dashboard", "Dashboard creation and browser permissions", 86_400_000],
  ] satisfies [string, string, number][]
).map(([key, displayName, age], index) => ({
  key,
  displayName,
  kind: "direct",
  updatedAt: Date.now() - age,
  owner: index < 2 ? { actor: owner } : undefined,
}));
const roster = { ts: 1, path: "", count: rows.length, defaults: {}, sessions: rows };
const snippets = [
  "After the migration, we are missing errors when a worker fails to start.",
  "The missing errors should appear in the session, not only in the logs.",
];
const transcript = {
  sessions: rows.slice(1),
  results: rows.slice(1).map((row, index) => ({
    sessionKey: row.key,
    sessionId: "fixture-" + index,
    messageId: "message-" + index,
    role: "assistant",
    timestamp: row.updatedAt,
    snippet: snippets[index],
    score: 10 - index,
  })),
};
const agent = (id: string, name: string, avatarUrl: string, emoji: string) => ({
  id,
  name,
  identity: { name, ...(avatarUrl ? { avatarUrl } : {}), emoji },
});
const agents = [
  agent("main", "Lobster", "/avatar/main", "🦞"),
  agent("reviewer", "Review bot", "", "🦀"),
];
suite.define(() => {
  it.each([
    { width: 1280, height: 900, mode: "light" },
    { width: 1280, height: 900, mode: "dark" },
    { width: 390, height: 844, mode: "light" },
  ] as const)(
    "keeps avatar search readable and actionable at $width px in $mode",
    async ({ width, height, mode }) => {
      await suite.withPage({ viewport: { width, height }, colorScheme: mode }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agent.identity.get": {
              cases: agents.map(({ id, name, identity }, index) => ({
                ...(index === 0 ? { match: { agentId: id } } : {}),
                response: { agentId: id, name, avatar: identity.avatarUrl ?? "" },
              })),
            },
            "sessions.list": {
              cases: [
                {
                  match: { search: "missing errors" },
                  response: { ...roster, count: 1, sessions: rows.slice(0, 1) },
                },
                { match: {}, response: roster },
              ],
            },
            "sessions.search": { ...transcript, indexing: true },
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents,
            },
            "models.list": {
              models: [{ provider: "fixture", id: "fixture-model", name: "Fixture model" }],
              refreshFailed: true,
            },
          },
        });
        await page.route("**/avatar/main", (route) =>
          route.fulfill({ contentType: "image/svg+xml", body: avatarSvg("#b8553c") }),
        );
        await page.route("**/api/users/profile-alex/avatar*", (route) =>
          route.fulfill({ contentType: "image/svg+xml", body: avatarSvg("#2b4968") }),
        );
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".shell").waitFor({ state: "visible" });
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await input.fill("missing errors");
        const results = page.locator(".cmd-palette__results");
        await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
        await expect.poll(() => results.getByRole("option").count()).toBe(3);
        await expect
          .poll(() =>
            results
              .locator(".cmd-palette__avatar img")
              .evaluateAll(
                (images) =>
                  images.filter(
                    (image) =>
                      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                  ).length,
              ),
          )
          .toBe(4);
        await waitForControlUiProofSurface(page.locator(".cmd-palette"), [results]);
        const transcriptRequests = await gateway.getRequests("sessions.search");
        expect(transcriptRequests).toHaveLength(1);
        expect(transcriptRequests[0]?.params).toEqual({
          query: "missing errors",
          limit: 25,
          scope: {
            includeGlobal: false,
            includeUnknown: false,
            configuredAgentsOnly: true,
            excludeSubagents: true,
            excludeCron: true,
            excludeSystem: true,
            excludeDock: true,
          },
        });
        expect(await results.locator(".cmd-palette__avatar").count()).toBe(3);
        expect(await results.locator(".cmd-palette__owner").count()).toBe(2);
        expect(await results.locator("mark").count()).toBeGreaterThan(0);
        expect(await results.getByRole("status").count()).toBe(0);
        const bounds = await page.locator(".cmd-palette").boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await results.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const filters = page.getByRole("group", { name: "Filter search results" });
        for (const [name, count] of [
          [/^Messages/, 2],
          [/^Sessions/, 1],
          [/^All/, 3],
        ] as const) {
          await filters.getByRole("button", { name }).click();
          await expect.poll(() => results.getByRole("option").count()).toBe(count);
        }
        expect(await page.getByText("Search notices", { exact: false }).count()).toBe(0);
        expect(
          await page.getByRole("status").filter({ hasText: "Indexing older messages" }).isVisible(),
        ).toBe(true);
        expect(await input.isVisible()).toBe(true);
        await gateway.setMethodResponse("sessions.search", {
          ...transcript,
          truncated: true,
        });
        await input.fill("missing errors ");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.search")).length)
          .toBe(2);
        await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
        await expect.poll(() => results.getByRole("option").count()).toBe(3);
        expect(
          await page.locator(".cmd-palette__search").getByRole("status").allTextContents(),
        ).toEqual([]);
        expect(
          await page.getByText(/Search notices|Indexing older messages|may be incomplete/).count(),
        ).toBe(0);
        await input.focus();
        await input.press("ArrowDown");
        await input.press("Enter");
        await expect.poll(() => input.count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );
});
