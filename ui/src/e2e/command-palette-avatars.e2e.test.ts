import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette avatars" });
const agentAvatar =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#e5d6b4"/><path d="M16 48 9 32m39 16 7-16" stroke="#b8553c" stroke-width="7" stroke-linecap="round"/><path d="M11 33C0 29 8 13 13 18l-1 8 6-5c6 7 2 15-7 12zm42 0c11-4 3-20-2-15l1 8-6-5c-6 7-2 15 7 12z" fill="#b8553c"/><rect x="21" y="21" width="22" height="34" rx="9" fill="#b8553c"/><path d="m25 22-3-11m17 11 3-11" stroke="#8e4934" stroke-width="3"/><rect x="21" y="26" width="22" height="14" rx="6" fill="#efd592"/><circle cx="27" cy="33" r="3" fill="#25343e"/><circle cx="37" cy="33" r="3" fill="#25343e"/><path d="M27 47h10m-11 5h12" stroke="#efd592" stroke-width="2"/></svg>';
const ownerAvatar =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#b5cfe0"/><path d="M8 64c2-17 13-22 24-22s23 5 25 22" fill="#2b4968"/><path d="M25 41h14v12H25" fill="#d4a480"/><ellipse cx="32" cy="28" rx="15" ry="20" fill="#e5b68d"/><path d="M17 28C10 6 26 3 37 7c13-1 15 10 11 23l-6-16c-8 5-14 3-19 2z" fill="#4a352c"/><path d="M19 34c2 12 7 17 13 17s12-6 14-17l-8 8H27z" fill="#77513c"/><circle cx="26" cy="29" r="1.6" fill="#283342"/><circle cx="38" cy="29" r="1.6" fill="#283342"/></svg>';
const owner = {
  type: "human" as const,
  id: "profile-alex",
  identity: { type: "profile" as const, id: "profile-alex" },
  label: "Alex Rivera",
};
const rows = [
  {
    key: "agent:main:search-design",
    kind: "direct",
    displayName: "Missing errors in the conversation",
    updatedAt: Date.now() - 240_000,
    owner: { actor: owner },
  },
  {
    key: "agent:main:worker",
    kind: "direct",
    displayName: "Post-migration worker launch failure",
    updatedAt: Date.now() - 7_200_000,
    owner: { actor: owner },
  },
  {
    key: "agent:reviewer:dashboard",
    kind: "direct",
    displayName: "Dashboard creation and browser permissions",
    updatedAt: Date.now() - 86_400_000,
  },
];
const roster = { ts: 1, path: "", count: rows.length, defaults: {}, sessions: rows };

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
            "sessions.list": {
              cases: [
                {
                  match: { search: "missing errors" },
                  response: { ...roster, count: 1, sessions: rows.slice(0, 1) },
                },
                { match: {}, response: roster },
              ],
            },
            "sessions.search": {
              sessions: rows.slice(1),
              results: rows.slice(1).map((row, index) => ({
                sessionKey: row.key,
                sessionId: "fixture-" + index,
                messageId: "message-" + index,
                role: "assistant",
                timestamp: row.updatedAt,
                snippet:
                  index === 0
                    ? "After the migration, we are missing errors when a worker fails to start."
                    : "The missing errors should appear in the session, not only in the logs.",
                score: 10 - index,
              })),
              indexing: true,
            },
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                {
                  id: "main",
                  name: "Lobster",
                  identity: { name: "Lobster", avatarUrl: "/avatar/main", emoji: "🦞" },
                },
                {
                  id: "reviewer",
                  name: "Review bot",
                  identity: { name: "Review bot", emoji: "🦀" },
                },
              ],
            },
            "models.list": {
              models: [{ provider: "fixture", id: "fixture-model", name: "Fixture model" }],
              refreshFailed: true,
            },
          },
        });
        await page.route("**/avatar/main", (route) =>
          route.fulfill({ contentType: "image/svg+xml", body: agentAvatar }),
        );
        await page.route("**/api/users/profile-alex/avatar", (route) =>
          route.fulfill({ contentType: "image/svg+xml", body: ownerAvatar }),
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
        await page.locator(".cmd-palette").screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "palette-" + width + "-" + mode + ".png"),
        });
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
        await filters.getByRole("button", { name: /^Messages/ }).click();
        await expect.poll(() => results.getByRole("option").count()).toBe(2);
        await filters.getByRole("button", { name: /^Sessions/ }).click();
        await expect.poll(() => results.getByRole("option").count()).toBe(1);
        await filters.getByRole("button", { name: /^All/ }).click();
        await expect.poll(() => results.getByRole("option").count()).toBe(3);
        expect(await page.getByText("Search notices", { exact: false }).count()).toBe(0);
        expect(
          await page.getByRole("status").filter({ hasText: "Indexing older messages" }).isVisible(),
        ).toBe(true);
        expect(await input.isVisible()).toBe(true);
        await gateway.setMethodResponse("sessions.search", {
          sessions: rows.slice(1),
          results: rows.slice(1).map((row, index) => ({
            sessionKey: row.key,
            sessionId: "fixture-" + index,
            messageId: "message-" + index,
            role: "assistant",
            timestamp: row.updatedAt,
            snippet: "The missing errors appear in this conversation.",
            score: 10 - index,
          })),
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
        ).toEqual(["Some models could not be refreshed. Open Models to try again."]);
        expect(
          await page.getByText(/Search notices|Indexing older messages|may be incomplete/).count(),
        ).toBe(0);
        await page.locator(".cmd-palette").screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "palette-limited-" + width + "-" + mode + ".png"),
        });
        await input.focus();
        await input.press("ArrowDown");
        await input.press("Enter");
        await expect.poll(() => input.count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );
});
