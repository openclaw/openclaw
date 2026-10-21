import { expect } from "playwright/test";
import { it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Packaged Memory search" });
suite.define(() => {
  it("searches packaged memories, shares safe file reads, and retires pending route work", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        locale: "en-US",
        colorScheme: "light",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const assets: Array<{ url: string; status: number }> = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.url().includes("/assets/plugins/memory-core/")) {
            assets.push({ url: new URL(response.url()).pathname, status: response.status() });
          }
        });
        const result = {
          path: "memory/people/ada.md",
          startLine: 2,
          endLine: 3,
          score: 0.876,
          snippet: "Ada prefers careful reviews.",
          source: "memory",
        };
        const response = {
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [
            result,
            { ...result, startLine: 1, endLine: 1 },
            { ...result, path: "memory/projects/Open Claw.md" },
            { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" },
            { ...result, path: "memory/../outside.md" },
          ],
        };
        const file = {
          file: { encoding: "utf8", content: "first\nmatched two\nmatched three\nfourth" },
        };
        const config = { agents: { entries: { main: {} } } };
        const gateway = await installMockGateway(page, {
          assistantAgentId: "main",
          defaultAgentId: "main",
          communityInvite: false,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "memory.search",
            "agents.workspace.get",
          ],
          methodResponses: {
            "config.get": configSnapshot(config, "memory-search-config"),
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
            "memory.search": response,
            "agents.workspace.get": file,
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/memory/memories`);
        await waitForControlUiRoute(page, { routeId: "memory" });
        const memories = page.locator(".memory-memories");
        const input = memories.getByRole("searchbox", { name: "Search memories" });
        const submit = memories.getByRole("button", { name: "Search", exact: true });
        const search = async (query: string) => {
          await input.fill(query);
          await submit.click();
        };
        await expect(input).toBeVisible();
        expect(await gateway.getRequests("memory.search")).toHaveLength(0);
        await search("  Ada  ");
        await gateway.waitForRequest("memory.search", { match: { agentId: "main", query: "Ada" } });
        await expect(memories).toContainText("5 results");
        await expect(memories).toContainText("hybrid search");
        const rows = memories.locator("article > button");
        await expect(rows).toHaveCount(3);
        await expect(memories.locator("article > div.settings-row")).toHaveCount(2);
        const readCount = await gateway.deferNext("agents.workspace.get");
        await rows.nth(0).click();
        await gateway.waitForRequest("agents.workspace.get", {
          after: readCount,
          match: { agentId: "main", path: result.path },
        });
        await rows.nth(1).click();
        await expect(rows.nth(0)).toHaveAttribute("aria-expanded", "false");
        await expect(rows.nth(1)).toHaveAttribute("aria-expanded", "true");
        expect(await gateway.getRequests("agents.workspace.get")).toHaveLength(1);
        await gateway.resolveDeferred("agents.workspace.get", file);
        await expect(memories.locator("[data-memory-match]")).toHaveText("first");
        await rows.nth(0).click();
        await expect(memories.locator("[data-memory-match]")).toHaveText(
          "matched two\nmatched three",
        );
        await expect(memories.locator(".memory-memories__detail")).toHaveCount(1);
        expect(await gateway.getRequests("agents.workspace.get")).toHaveLength(1);
        for (const ext of [".js", ".css"]) {
          expect(assets.some((asset) => asset.url.endsWith(ext) && asset.status === 200)).toBe(
            true,
          );
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "light");

        const searchCount = await gateway.deferNext("memory.search");
        await search("Retired query");
        await gateway.waitForRequest("memory.search", { after: searchCount });
        await page.locator("#memory-tab-settings").click();
        await expect(memories).toHaveCount(0);
        await gateway.resolveDeferred("memory.search", response);
        await page.locator("#memory-tab-memories").click();
        await expect(input).toHaveValue("");
        await expect(memories.locator("article")).toHaveCount(0);
        await search("Ada again");
        await expect(rows).toHaveCount(3);
        const nextRead = await gateway.deferNext("agents.workspace.get");
        await rows.nth(0).click();
        await gateway.waitForRequest("agents.workspace.get", { after: nextRead });
        await page.locator("#memory-tab-settings").click();
        await expect(memories).toHaveCount(0);
        await gateway.rejectDeferred("agents.workspace.get", { message: "Retired file failure" });
        await page.locator("#memory-tab-memories").click();
        await expect(input).toHaveValue("");
        await expect(memories).not.toContainText("Retired file failure");
        await search("Fresh query");
        await expect(rows).toHaveCount(3);
        expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
        expect(errors).toEqual([]);
      },
    );
  });
});
