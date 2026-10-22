import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { singleFileDiff } from "./chat-session-diff.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "File comments" });

suite.define(() => {
  it("stages a selected file passage with its location and sends the comment without changing the file", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "Review `src/retry.ts`." }],
          methodResponses: {
            "sessions.files.get": {
              root: "/workspace",
              file: {
                previewKind: "text",
                contentEncoding: "utf8",
                content: "export function retry() {\n  return 3;\n}\n",
                kind: "read",
                missing: false,
                name: "retry.ts",
                path: "src/retry.ts",
                workspacePath: "src/retry.ts",
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator('a.markdown-file-link[data-file-path="src/retry.ts"]').click();
        const line = page.locator(".cm-content .cm-line").nth(1);
        await line.waitFor();
        const composer = page.locator(".agent-chat__composer-shell textarea");
        await composer.fill("Please address this feedback.");
        await line.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await line.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
        if (process.env.OPENCLAW_FILE_COMMENT_CAPTURE === "before") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".sidebar-file-view:visible"),
            [line],
            { animations: "disabled" },
          );
          await writeFile(`${suite.artifactDir}/before.png`, frame.png);
        }
        await page.getByRole("button", { name: "Add to chat", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Make the retry count configurable here.");
        if (process.env.OPENCLAW_FILE_COMMENT_CAPTURE === "after") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".sidebar-file-view:visible"),
            [line],
            { animations: "disabled" },
          );
          await writeFile(`${suite.artifactDir}/after.png`, frame.png);
        }
        await editor.getByRole("textbox").press("Enter");
        expect(await composer.inputValue()).toBe("Please address this feedback.");
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.waitFor();
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.getByText("src/retry.ts:2", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        // SAFETY: the mock captures the real chat.send request emitted by the composer.
        const params = request.params as {
          message: string;
          attachments: Array<{ content: string }>;
        };
        expect(params.message).toContain("Please address this feedback.");
        const payload = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
        expect(payload).toContain("  return 3;");
        expect(payload).toContain("Make the retry count configurable here.");
        expect(payload).toContain('Source file: "src/retry.ts"');
        expect(payload).toContain("Source lines: 2-2");
        expect(await gateway.getRequests("sessions.files.set")).toHaveLength(0);
      },
    );
  });

  it.each(["old", "new"] as const)(
    "sends a Review comment with the %s revision coordinates",
    async (side) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          await page.addInitScript(
            (mode) =>
              localStorage.setItem(
                "openclaw.control.sessionDiff.v1",
                JSON.stringify({ mode, split: mode === "split", wrap: false }),
              ),
            side === "new" ? "split" : "unified",
          );
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
            methodResponses: {
              "sessions.files.list": {
                sessionKey: "main",
                root: "/workspace",
                files: [],
                browser: { path: "", entries: [] },
              },
              "sessions.diff": singleFileDiff(
                "src/retry.ts",
                "@@ -1,3 +1,3 @@\n export function retry() {\n-  return 3;\n+  return 5;\n }\n",
                1,
                1,
              ),
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await openChatSidePanelType(page, "Files");
          await openChatSidePanelType(page, "Review");
          await page.locator(".session-diff__file-toggle").click();
          const line = page
            .locator(`[data-comment-line="2"][data-comment-side="${side}"]`)
            .filter({ visible: true });
          await line.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
          await line.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
          await page.getByRole("button", { name: "Add to chat", exact: true }).click();
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          await editor.getByRole("textbox").fill("Explain this retry limit.");
          await editor.getByRole("textbox").press("Enter");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          // SAFETY: the mock captures the actual request emitted by the composer.
          const params = request.params as { attachments: Array<{ content: string }> };
          const payload = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
          expect(payload).toContain(`Source diff side: ${side}`);
          expect(payload).toContain("Source lines: 2-2");
          expect(payload).toContain(side === "old" ? "  return 3;" : "  return 5;");
        },
      );
    },
  );
});
