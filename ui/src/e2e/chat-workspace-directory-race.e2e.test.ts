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
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Open `reports/inventory.csv`." }] },
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          [listMethod]: rootListing,
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
      const fileTab = page.getByRole("tab", { name: "inventory.csv", exact: true });
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      await gateway.resolveDeferred(listMethod, {
        ...rootListing,
        browser: {
          path: "",
          entries: [{ kind: "directory", name: "refreshed-root", path: "refreshed-root" }],
        },
      });
      // Observe the held listing committing before checking the retained selection.
      await rail
        .getByRole("button", { name: "refreshed-root", exact: true, includeHidden: true })
        .waitFor({ state: "attached" });
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      expect(
        await page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent(),
      ).toContain("notebooks");
      const requests = await gateway.getRequests(listMethod);
      expect(requests.map((request) => request.params)).toEqual(
        ["", ""].map((folderPath) =>
          expect.objectContaining({
            sessionKey: "agent:main:main",
            path: folderPath,
            search: "",
            agentId: "main",
          }),
        ),
      );
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(1);
    });
  });
});
