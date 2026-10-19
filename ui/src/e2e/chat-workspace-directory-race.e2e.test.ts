import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();
const listMethod = "sessions.files.list";
const dir = (name: string) => ({ kind: "directory", name, path: name });
function listing<T>(sessionKey: string, folder: string, entries: T[], parentPath?: string) {
  return {
    sessionKey,
    root: "/workspace",
    files: [],
    browser: { path: folder, entries, ...(parentPath === undefined ? {} : { parentPath }) },
  };
}

suite.define(() => {
  it.each([false, true])(
    "keeps parent navigation usable after a directory refresh (missing: %s)",
    async (missing) => {
      await suite.withPage({}, async ({ page }) => {
        const baseListing = { sessionKey: "main", root: "/workspace", files: [] };
        const rootListing = listing("main", "", [dir("reports"), dir("other")]);
        const directoryListing = (folder: string, name: string) =>
          listing(
            "main",
            folder,
            [{ kind: "file", name, path: `${folder}/${name}`, size: 12 }],
            "",
          );
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "artifacts.list": { artifacts: [] },
            [listMethod]: rootListing,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Files");
        const rail = page.locator(".chat-workspace-rail");
        const file = (name: string) => rail.getByRole("button", { name, exact: true });
        await file("reports").waitFor();
        await gateway.setMethodResponse(listMethod, directoryListing("reports", "notes.md"));
        await file("reports").click();
        const originalFile = file("reports/notes.md");
        await originalFile.waitFor();

        // A removed or renamed directory returns a successful listing without browser.
        await gateway.setMethodResponse(
          listMethod,
          missing ? baseListing : directoryListing("reports", "refreshed.md"),
        );
        await gateway.emitChatFinal({ runId: "folder-change", text: "Workspace updated." });
        await originalFile.waitFor({ state: "hidden" });
        if (!missing) {
          await file("reports/refreshed.md").waitFor();
        }
        const parent = file("..");
        await expect.poll(() => parent.isVisible()).toBe(true);

        await gateway.setMethodResponse(listMethod, {
          ...rootListing,
          browser: {
            ...rootListing.browser,
            entries: rootListing.browser.entries.filter(
              (entry) => !missing || entry.path !== "reports",
            ),
          },
        });
        await parent.click();
        await file("other").waitFor();
        await gateway.setMethodResponse(listMethod, directoryListing("other", "keep.md"));
        await file("other").click();
        await file("other/keep.md").waitFor();
      });
    },
  );

  it("keeps a newly opened project file selected after an older directory response", async () => {
    await suite.withPage({}, async ({ page }) => {
      const rootListing = listing("agent:main:main", "", [dir("reports")]);
      const reportsListing = listing("agent:main:main", "reports", [
        { kind: "file", name: "inventory.csv", path: "reports/inventory.csv", size: 24 },
      ]);
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Open `reports/inventory.csv`." }] },
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          [listMethod]: {
            cases: [
              { match: { path: "" }, response: rootListing },
              { match: { path: "reports" }, response: reportsListing },
            ],
          },
          "sessions.files.get": {
            sessionKey: "agent:main:main",
            root: "/workspace",
            file: {
              name: "inventory.csv",
              path: "reports/inventory.csv",
              workspacePath: "reports/inventory.csv",
              content: "item,count\nnotebooks,3\n",
              previewKind: "text",
              contentEncoding: "utf8",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".chat-workspace-rail");
      await rail.getByRole("button", { name: "reports", exact: true }).waitFor();
      const rootRequest = {
        sessionKey: "agent:main:main",
        agentId: "main",
        path: "",
        search: "",
      };
      const beforeRefresh = (await gateway.getRequests(listMethod, rootRequest)).length;
      await gateway.deferNext(listMethod);
      await gateway.emitChatFinal({ runId: "directory-refresh", text: "Report is ready." });
      await gateway.waitForRequest(listMethod, {
        after: beforeRefresh,
        match: rootRequest,
      });
      await page.locator('a.markdown-file-link[data-file-path="reports/inventory.csv"]').click();
      await expect
        .poll(() => page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent())
        .toContain("notebooks");
      await page
        .locator('[data-region-header="side"]')
        .getByRole("button", { name: "Files", exact: true })
        .click();
      const directoryRequest = { ...rootRequest, path: "reports" };
      const beforeBrowse = (await gateway.getRequests("sessions.files.list", directoryRequest))
        .length;
      await rail.getByRole("button", { name: "reports", exact: true }).click();
      await gateway.resolveDeferred(listMethod, rootListing);
      await gateway.waitForRequest(listMethod, {
        after: beforeBrowse,
        match: directoryRequest,
      });
      const row = rail.locator(".chat-workspace-rail__file").filter({ hasText: "inventory.csv" });
      await row.waitFor();
      const fileRequests = await gateway.getRequests("sessions.files.get");
      expect(fileRequests).toHaveLength(1);
      expect(fileRequests[0]?.params).toMatchObject({
        sessionKey: "agent:main:main",
        agentId: "main",
        path: "reports/inventory.csv",
      });
      await page.mouse.click(600, 300);
      expect(await row.getAttribute("class")).toContain("chat-workspace-rail__file--active");
    });
  });
});
