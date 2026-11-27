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
  it("keeps resumed tool activity below the opening request before history catches up", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 820 }, locale: "en-US" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
        await page.goto(suite.server.baseUrl + "chat");
        const prompt = "Inspect the project layout.";
        await page.locator(".agent-chat__input textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = String(asOptionalRecord(request.params)?.idempotencyKey);
        const message = {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
          __openclaw: { id: "opening", seq: 1, idempotencyKey: runId + ":user" },
        };
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: "opening",
          messageSeq: 1,
          message,
        });
        const user = page.locator(".chat-group.user", { hasText: prompt });
        await user.waitFor();
        // The same conversation continues under a new run ID before its history arrives.
        await gateway.emitGatewayEvent("session.tool", {
          sessionKey,
          runId: "resumed",
          seq: 2,
          ts: message.timestamp + 100,
          stream: "tool",
          data: { phase: "result", toolCallId: "layout", name: "exec", result: "" },
        });
        const row = page.locator(".chat-tool-msg-summary", { hasText: "Ran a script" });
        await row.waitFor();
        // History can replace a row between two Playwright reads. Compare the first frame
        // with both rows painted; a reversed order must fail rather than be retried.
        const order = await page.waitForFunction((openingText) => {
          const rect = (selector: string, text: string) =>
            Array.from(document.querySelectorAll(selector))
              .find((element) => element.textContent?.includes(text))
              ?.getClientRects()[0];
          const opening = rect(".chat-group.user", openingText);
          const tool = rect(".chat-tool-msg-summary", "Ran a script");
          if (opening?.height && tool?.height) {
            return opening.top < tool.top ? "opening-first" : "tool-first";
          }
          return false;
        }, prompt);
        if (captureUiProof) {
          await capture(page, createControlUiE2eArtifactDir("resumed-tool-order"), "transcript");
        }
        expect(await order.jsonValue()).toBe("opening-first");
      },
    );
  });
  it("does not call a complete image-only result unavailable", async () => {
    const imageResult = {
      ...result,
      toolName: "visual_snapshot",
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RuoAAAAASUVORK5CYII=",
        },
      ],
    };
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.history": prepareChatHistoryFixture([
              { role: "user", content: "Inspect the image result.", timestamp },
              {
                role: "assistant",
                timestamp: timestamp + 1,
                content: [{ ...toolCall({ viewport: "desktop" }), name: "visual_snapshot" }],
              },
              imageResult,
              { role: "assistant", content: "The image is ready.", timestamp: timestamp + 3 },
            ]),
            "chat.message.get": { ok: true, message: imageResult },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await expandGroups(page, "The image is ready.");
        await page.locator('.chat-tool-msg-summary[aria-expanded="false"]').first().click();
        await page.locator('openclaw-chat-tool-card .chat-tool-row[aria-expanded="false"]').click();
        await page
          .getByRole("button", { name: "Open tool details in side panel", exact: true })
          .click();
        await gateway.waitForRequest("chat.message.get");
        const panel = page.locator("openclaw-chat-tool-output");
        await panel.locator('.chat-tool-output[aria-busy="false"]').waitFor();
        if (captureUiProof) {
          await capture(page, suite.artifactDir, "tool-output-header");
        }
        const pane = await page.locator(".side-panel__header:visible").boundingBox();
        expect(await panel.locator(".sidebar-header").boundingBox()).toMatchObject({
          x: expect.closeTo(pane!.x, 0),
          width: expect.closeTo(pane!.width, 0),
        });
        expect(
          await panel
            .getByText("Full output unavailable. Only the captured output is shown.", {
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect(await panel.locator(".chat-tool-output__actions").count()).toBe(0);
        await panel.getByText("Tool input", { exact: true }).click();
        expect(await panel.textContent()).toContain("desktop");
      },
    );
  });
  it("keeps captured text and its warning when the full result is genuinely unavailable", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.history": history,
            "chat.message.get": { ok: false, unavailableReason: "oversized" },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await expandGroups(page, "Output is ready for inspection.");
        await page.locator('.chat-tool-msg-summary[aria-expanded="false"]').first().click();
        await page.getByRole("button", { name: "Show full output", exact: true }).click();
        await gateway.waitForRequest("chat.message.get");
        const panel = page.locator("openclaw-chat-tool-output");
        const warning = panel.getByText(
          "Full output unavailable. Only the captured output is shown.",
          { exact: true },
        );
        await warning.waitFor();
        expect(await panel.locator(".chat-tool-output__text").textContent()).toBe(
          fullOutput.slice(0, 2_000),
        );
        expect(
          await panel
            .getByRole("button", { name: "Download available output", exact: true })
            .isVisible(),
        ).toBe(true);
      },
    );
  });

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
          "Ran a script",
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
          const row = page.locator(".chat-tool-msg-summary", {
            hasText: "printf 'capture output'",
          });
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
