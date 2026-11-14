import { readFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Tool output fidelity",
  // Native clipboard contents are shared across contexts in the same browser.
  browserLaunchOptions: { headless: true },
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
  isError: false,
  timestamp: timestamp + 2,
  content: [{ type: "text", text: fullOutput }],
  __openclaw: {
    id: "output-result",
    toolOutput: { source: "provider-response", modelInput: "unverified" },
  },
};
const toolCall = (args: Record<string, unknown>) => ({
  type: "toolCall",
  id: "output-call",
  name: "exec",
  arguments: args,
});
const history = prepareChatHistoryFixture([
  { role: "user", content: "Inspect the complete command output.", timestamp },
  {
    role: "assistant",
    timestamp: timestamp + 1,
    __openclaw: { id: "output-request" },
    content: [toolCall({ command: "printf 'capture output'", title: "Capture command output" })],
  },
  {
    ...result,
    content: [{ type: "text", text: fullOutput.slice(0, 2_000) }],
    __openclaw: { ...result["__openclaw"], truncated: true, reason: "display-cap" },
  },
  { role: "assistant", content: "Output is ready for inspection.", timestamp: timestamp + 3 },
]);
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const capture = (page: Page, dir: string | undefined, name: string) => {
  if (dir && captureUiProof) {
    return page.screenshot({ path: path.join(dir, name + ".png"), animations: "disabled" });
  }
  return undefined;
};
async function expandGroups(page: Page, reply: string) {
  await page.getByText(reply, { exact: true }).waitFor();
  for (const group of await page
    .locator('.chat-activity-group__summary[aria-expanded="false"]')
    .all()) {
    await group.click();
  }
}

suite.define(() => {
  it("renders native Code Mode results without transport envelopes", async () => {
    const artifacts = captureUiProof
      ? createControlUiE2eArtifactDir("code-mode-output")
      : undefined;
    const source =
      'text(await tools.exec_command({cmd: "check-service", max_output_tokens: 1000}));';
    const payload =
      '{"gateway":{"state":"running","pid":12345},"previousAttempt":{"exitCode":1},"journalUnchanged":true}';
    const rawOutput = JSON.stringify(
      [
        { type: "input_text", text: "Script completed\nWall time 0.8 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: JSON.stringify({
            chunk_id: "fixture-chunk",
            wall_time_seconds: 0.77,
            exit_code: 0,
            original_token_count: 137,
            output: payload + "\n",
          }),
        },
      ],
      null,
      2,
    );
    const nativeResult = {
      ...result,
      content: [{ type: "text", text: rawOutput }],
    };
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "chat.history": prepareChatHistoryFixture([
              { role: "user", content: "Check the service and the previous attempt.", timestamp },
              {
                role: "assistant",
                timestamp: timestamp + 1,
                content: [toolCall({ input: source })],
              },
              nativeResult,
              { role: "assistant", content: "The service is running.", timestamp: timestamp + 3 },
            ]),
            "chat.message.get": { ok: true, message: nativeResult },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await expandGroups(page, "The service is running.");
        const row = page.locator('.chat-tool-msg-summary[aria-expanded="false"]').first();
        await row.click();
        await capture(page, artifacts, "01-expanded");
        expect(await page.locator(".chat-tool-msg-summary").textContent()).toContain(
          "run JavaScript",
        );
        const body = page.locator(".chat-tool-msg-body");
        expect(await body.locator(".chat-tool-card__outcome").textContent()).toBe("Completed");
        const visibleOutput = body.locator(".chat-tool-card__block-content").first();
        expect(await visibleOutput.textContent()).toContain('"state": "running"');
        expect(await visibleOutput.textContent()).not.toContain("chunk_id");
        expect(await body.textContent()).not.toContain("Captured before");
        const sourceBlock = body.locator(".chat-tool-card__input .chat-tool-card__block-content");
        expect(await sourceBlock.isVisible()).toBe(false);
        await body.getByText("Tool input", { exact: true }).click();
        expect(await sourceBlock.isVisible()).toBe(true);
        expect(await sourceBlock.textContent()).toBe(source);
        await body.getByRole("button", { name: "Raw details", exact: true }).click();
        expect(await body.locator(".chat-tool-card__raw-body code").textContent()).toBe(rawOutput);
        await page.reload();
        await expandGroups(page, "The service is running.");
        await page.locator('.chat-tool-msg-summary[aria-expanded="false"]').first().click();
        expect(await body.locator(".chat-tool-card__outcome").textContent()).toBe("Completed");
        await page.setViewportSize({ width: 390, height: 844 });
        await capture(page, artifacts, "02-mobile-reloaded");
        expect(await visibleOutput.textContent()).toContain('"state": "running"');
      },
    );
  });

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
          await expandGroups(page, "Output is ready for inspection.");
          const row = page.locator(".chat-tool-msg-summary", { hasText: "Capture command output" });
          await row.waitFor();
          if ((await row.getAttribute("aria-expanded")) !== "true") {
            await row.click();
          }
        };
        await page.goto(suite.server.baseUrl + "chat");
        await expandOutput();
        await capture(page, artifacts, "01-output-preview");
        const historyParams = (await gateway.getRequests()).flatMap((request) => {
          const params = asOptionalRecord(request.params);
          return request.method === "chat.history" || request.method === "chat.startup"
            ? [params]
            : request.method === "sessions.messages.subscribe" && params?.initialHistory
              ? [asOptionalRecord(params.initialHistory)]
              : [];
        });
        expect(historyParams.length).toBeGreaterThan(0);
        expect(historyParams.every((params) => params?.toolResultMaxChars === 2_000)).toBe(true);
        expect(await page.locator(".chat-tool-msg-body").textContent()).not.toContain("TAIL:");
        await page.getByRole("button", { name: "Show full output", exact: true }).click();
        const request = await gateway.waitForRequest("chat.message.get");
        expect(request.params).toMatchObject({ messageId: "output-result" });
        expect(asOptionalRecord(request.params)?.maxChars).toBeGreaterThanOrEqual(
          fullOutput.length,
        );
        const output = page.locator(".chat-tool-output__text");
        await expect.poll(() => output.textContent()).toBe(fullOutput);
        expect(await page.locator("openclaw-chat-tool-output").textContent()).not.toContain(
          "Captured before context processing",
        );
        await capture(page, artifacts, "02-full-output");
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
        await capture(page, artifacts, "03-full-output-tail");

        await page.reload();
        await expandOutput();
        await page.getByRole("button", { name: "Show full output", exact: true }).click();
        await expect.poll(() => output.textContent()).toBe(fullOutput);
        await page.setViewportSize({ width: 390, height: 844 });
        await capture(page, artifacts, "04-reloaded-mobile");
      },
    );
  });
});
