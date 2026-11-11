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
    "keeps sibling folders usable after a directory refresh (missing: %s)",
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
        const rail = page.locator(".workspace-desktop");
        const file = (name: string) => rail.getByRole("button", { name, exact: true });
        await rail.getByRole("button", { name: "reports", exact: true }).waitFor();
        await gateway.setMethodResponse(listMethod, directoryListing("reports", "notes.md"));
        await rail.getByRole("button", { name: "reports", exact: true }).click();
        const originalFile = rail.getByRole("button", {
          name: "reports/notes.md",
          exact: true,
        });
        await originalFile.waitFor();

        // A removed or renamed directory returns a successful listing without browser.
        const refreshedRoot = {
          ...rootListing,
          browser: {
            ...rootListing.browser,
            entries: rootListing.browser.entries.filter(
              (entry) => !missing || entry.path !== "reports",
            ),
          },
        };
        await gateway.setMethodResponse(listMethod, {
          cases: [
            { match: { path: "" }, response: refreshedRoot },
            {
              match: { path: "reports" },
              response: missing ? baseListing : directoryListing("reports", "refreshed.md"),
            },
          ],
        });
        await gateway.emitChatFinal({ runId: "folder-change", text: "Workspace updated." });
        await originalFile.waitFor({ state: "hidden" });
        if (!missing) {
          await file("reports/refreshed.md").waitFor();
        }
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
      const rail = page.locator(".workspace-desktop");
      await rail.getByRole("button", { name: "reports", exact: true }).waitFor();
      await gateway.deferNext(listMethod, { path: "" });
      await gateway.emitChatFinal({ runId: "directory-refresh", text: "Report is ready." });
      await expect.poll(async () => (await gateway.getRequests(listMethod)).length).toBe(2);
      await page.locator('a.markdown-file-link[data-file-path="reports/inventory.csv"]').click();
      await expect
        .poll(() => page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent())
        .toContain("notebooks");
      const fileTab = page.getByRole("tab", { name: "inventory.csv", exact: true });
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      await page.getByRole("button", { name: "Toggle file tree", exact: true }).click();
      await rail.getByRole("button", { name: "reports", exact: true }).click();
      await gateway.resolveDeferred(
        listMethod,
        {
          ...rootListing,
          browser: {
            ...rootListing.browser,
            entries: [
              ...rootListing.browser.entries,
              { kind: "directory", name: "refreshed-root", path: "refreshed-root" },
            ],
          },
        },
        { match: { path: "" } },
      );
      // This new root entry proves the held response committed before selection is checked.
      await rail.getByRole("button", { name: "refreshed-root", exact: true }).waitFor();
      const row = rail.getByRole("button", { name: "reports/inventory.csv", exact: true });
      await row.waitFor();
      await page.mouse.click(600, 300);
      expect(await row.getAttribute("aria-current")).toBe("true");
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      expect(
        await page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent(),
      ).toContain("notebooks");
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(1);
      const requests = await gateway.getRequests(listMethod);
      expect(requests.map((request) => request.params)).toEqual(
        ["", "", "reports"].map((folderPath) => expect.objectContaining({ path: folderPath })),
      );
    });
  });
});
