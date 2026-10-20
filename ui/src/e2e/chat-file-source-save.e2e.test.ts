import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { exactButton, polledText } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Files source-aware save" });
const sessionKey = "agent:main:main";
const viewport = { width: 1280, height: 900 };
const changedSourceMessage =
  "The file's workspace changed. Reopen the file before saving; your draft was preserved.";

suite.define(() => {
  it("keeps an old workspace draft separate when the same file is reopened", async () => {
    const initial = "# Workspace notes\n\nOriginal project notes.\n";
    const draft = "# Workspace notes\n\nUnsaved work from workspace A.\n";
    let workspaceId = "workspace-a";
    let savedContent = initial;
    let saves = 0;
    await suite.withPage(
      { viewport, recordVideo: { dir: suite.artifactDir, size: viewport } },
      async ({ page }) => {
        const gateway = await installMockGateway(
          page,
          {
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set"],
            historyMessages: [chatMessage("assistant", "Review `notes.md`.", { timestamp: 1 })],
          },
          {
            requestHandlers: {
              "sessions.files.get": () => ({
                sessionKey,
                root: "/workspace",
                source: { workspaceId, root: "/workspace", fileRoot: "/workspace" },
                file: {
                  name: "notes.md",
                  path: "notes.md",
                  workspacePath: "notes.md",
                  kind: "read",
                  missing: false,
                  previewKind: "text",
                  contentEncoding: "utf8",
                  content: savedContent,
                  hash: "unchanged-file-hash",
                },
              }),
              "sessions.files.set": (params) => {
                const request = params as {
                  content: string;
                  expectedSource?: { workspaceId: string; root: string; fileRoot: string };
                };
                if (
                  request.expectedSource !== undefined &&
                  (request.expectedSource.workspaceId !== workspaceId ||
                    request.expectedSource.root !== "/workspace" ||
                    request.expectedSource.fileRoot !== "/workspace")
                ) {
                  return {
                    __mockError: {
                      code: "INVALID_REQUEST",
                      message: changedSourceMessage,
                      details: { type: "session_file_source_changed" },
                    },
                  };
                }
                saves += 1;
                savedContent = request.content;
                return {
                  sessionKey,
                  source: { workspaceId, root: "/workspace", fileRoot: "/workspace" },
                  file: { hash: "saved-file-hash" },
                };
              },
            },
          },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const link = page.locator('a.markdown-file-link[data-file-path="notes.md"]');
        await link.click();
        const file = page.locator(".sidebar-file-view");
        const editor = file.locator(".cm-content");
        await exactButton(file, "Edit file").click();
        await editor.fill(draft);
        workspaceId = "workspace-b";
        await page.evaluate(() => {
          const cue = document.createElement("div");
          cue.textContent =
            "Proof fixture: workspace A replaced by B; file path and bytes unchanged";
          cue.style.cssText =
            "position:fixed;bottom:12px;left:12px;z-index:99999;background:#17212b;color:white;padding:10px 16px;border-radius:6px;font:14px system-ui;pointer-events:none";
          document.body.append(cue);
        });
        await exactButton(file, "Save").click();
        await gateway.waitForRequest("sessions.files.set");
        await expect
          .poll(
            async () =>
              (await file.locator('[role="alert"]').count()) > 0 ||
              (await exactButton(file, "Save").isDisabled()),
          )
          .toBe(true);
        const frame = await takeControlUiScreenshotFrame(page, file, [editor], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(suite.artifactDir, "stale-save.png"), frame.png);
        console.log(`Files source save capture: ${suite.artifactDir}`);
        expect(saves).toBe(0);
        expect(savedContent).toBe(initial);
        await polledText(file.locator('[role="alert"]')).toContain("workspace changed");
        await polledText(editor).toContain("Unsaved work from workspace A.");
        expect(await exactButton(file, "Save").isDisabled()).toBe(false);
        expect(await file.getByRole("button", { name: "Overwrite", exact: true }).count()).toBe(0);

        await exactButton(page, "Close tab: notes.md").click();
        await link.click();
        await polledText(editor).toContain("Original project notes.");
        expect(await editor.textContent()).not.toContain("Unsaved work from workspace A.");
        await exactButton(file, "Edit file").click();
        await editor.fill("Fresh edit in workspace B.\n");
        await exactButton(file, "Save").click();
        await expect.poll(() => saves).toBe(1);
        expect(savedContent).toBe("Fresh edit in workspace B.\n");
      },
    );
  });
});
