import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Tool output fidelity",
  startServerBeforeBrowser: true,
});
const timestamp = Date.UTC(2026, 8, 19, 12);
const fullOutput =
  "  Command output begins\r\n" +
  "Deterministic output line for full-output inspection.\r\n".repeat(12_000) +
  "\r\nTAIL: the complete captured result 🦞\r\n";
const result = {
  role: "toolResult",
  toolCallId: "output-call",
  toolName: "exec",
  timestamp: timestamp + 2,
  content: [{ type: "text", text: fullOutput }],
  __openclaw: {
    id: "output-result",
    toolOutput: { source: "provider-response", modelInput: "unverified" },
  },
};
const history = prepareChatHistoryFixture([
  { role: "user", content: "Inspect the complete command output.", timestamp },
  {
    role: "assistant",
    timestamp: timestamp + 1,
    __openclaw: { id: "output-request" },
    content: [
      {
        type: "toolCall",
        id: "output-call",
        name: "exec",
        arguments: { command: "printf 'capture output'", title: "Capture command output" },
      },
    ],
  },
  {
    ...result,
    content: [{ type: "text", text: fullOutput.slice(0, 8_000) }],
    __openclaw: { ...result["__openclaw"], truncated: true, reason: "display-cap" },
  },
  { role: "assistant", content: "Output is ready for inspection.", timestamp: timestamp + 3 },
]);

suite.define(() => {
  it("recovers full tool text after history reload and exports exact captured bytes", async () => {
    const artifacts = createControlUiE2eArtifactDir("tool-output-fidelity");
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: suite.server.baseUrl,
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.history": history,
            "chat.message.get": { ok: true, message: result },
          },
        });
        const expandOutput = async () => {
          await page.getByText("Output is ready for inspection.", { exact: true }).waitFor();
          const groups = page.locator('.chat-activity-group__summary[aria-expanded="false"]');
          for (const group of await groups.all()) {
            await group.click();
          }
          const row = page.locator(".chat-tool-msg-summary", { hasText: "Capture command output" });
          await row.waitFor();
          if ((await row.getAttribute("aria-expanded")) !== "true") {
            await row.click();
          }
        };
        await page.goto(suite.server.baseUrl + "chat");
        await expandOutput();
        // This capture precedes the new control assertion, so the same test also
        // retains an honest pre-fix screenshot when run against the baseline.
        await page.screenshot({
          path: path.join(artifacts, "01-output-preview.png"),
          animations: "disabled",
        });
        expect(await page.locator(".chat-tool-msg-body").textContent()).not.toContain("TAIL:");
        await page.getByRole("button", { name: "Show full output", exact: true }).click();
        const request = await gateway.waitForRequest("chat.message.get");
        expect(request.params).toMatchObject({ messageId: "output-result", maxChars: 2_000_000 });
        const output = page.locator(".chat-tool-output__text");
        await expect.poll(() => output.textContent()).toBe(fullOutput);
        await page
          .getByText("Captured before context processing. The exact model input is unverified.", {
            exact: true,
          })
          .last()
          .waitFor();
        await page.screenshot({
          path: path.join(artifacts, "02-full-output.png"),
          animations: "disabled",
        });
        await page.getByRole("button", { name: "Copy available output", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(fullOutput);
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download available output", exact: true }).click();
        const download = await downloadEvent;
        const downloadedPath = path.join(artifacts, "captured-tool-output.txt");
        await download.saveAs(downloadedPath);
        expect(await readFile(downloadedPath, "utf8")).toBe(fullOutput);
        await page.locator("openclaw-chat-tool-output").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await page.screenshot({
          path: path.join(artifacts, "03-full-output-tail.png"),
          animations: "disabled",
        });

        await page.reload();
        await expandOutput();
        await page.getByRole("button", { name: "Show full output", exact: true }).click();
        await expect.poll(() => output.textContent()).toBe(fullOutput);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: path.join(artifacts, "04-reloaded-mobile.png"),
          animations: "disabled",
        });
      },
    );
  });
});
