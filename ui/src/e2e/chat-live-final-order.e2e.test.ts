import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
function message(role: string, text: string, extra = {}, timestamp = Date.now()) {
  return { role, content: [{ type: "text", text }], timestamp, ...extra };
}
const doneSession = () => ({
  activeRunIds: [],
  hasActiveRun: false,
  key: "main",
  kind: "direct",
  status: "done",
  updatedAt: Date.now(),
});
function proofDirectory(name: string) {
  const root = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  return root ? createControlUiE2eArtifactDir(name, root) : undefined;
}
async function screenshot(page: Page, directory: string | undefined, name: string) {
  if (directory) {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(directory, name),
    });
  }
}
function expectBubbleOrder(page: Page, texts: string[]) {
  return expect
    .poll(() =>
      page.locator(".chat-thread-inner").evaluate((thread, values) => {
        const rows = Array.from(thread.querySelectorAll(".chat-bubble"));
        return values.map((text) => rows.findIndex((row) => row.textContent?.includes(text)));
      }, texts),
    )
    .toEqual(texts.map((_, index) => index));
}

function canvasPreview(viewId: string) {
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId,
    title: `Preview ${viewId}`,
    url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
    preferredHeight: 120,
    sandbox: "scripts",
  };
}

function canvasToolResult(viewId: string, toolCallId: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "show_widget",
    timestamp,
    content: JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: viewId,
        url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      },
      presentation: {
        target: "assistant_message",
        title: `Preview ${viewId}`,
        preferred_height: 120,
        sandbox: "scripts",
      },
    }),
  };
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("renders each persisted Canvas view once after reload", async () => {
    const artifactDir = proofDirectory("chat-canvas-history-stability");
    const page = await newChatPage(suite);
    const documentIds = ["cv_first", "cv_second"];
    const finalText = "Both previews are ready.";
    const messages = [
      message("user", "Show both previews.", {}, 1_000),
      canvasToolResult("cv_first", "call-first", 1_001),
      canvasToolResult("cv_second", "call-second", 1_002),
      {
        role: "assistant",
        timestamp: 1_003,
        content: [
          {
            type: "text",
            text: `[embed ref="cv_first" /]\n[embed ref="cv_second" /]\n${finalText}`,
          },
          ...documentIds.map((viewId) => ({ type: "canvas", preview: canvasPreview(viewId) })),
        ],
      },
    ];

    const gateway = await installMockGateway(page, {
      historyMessages: messages,
      methodResponses: {
        "canvas.document.view": {
          cases: documentIds.map((docId) => ({
            match: { docId },
            response: canvasView(
              buildWidgetDocument(`Preview ${docId}`, `<p>Rendered ${docId}</p>`),
            ),
          })),
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");

    const readPreviews = () =>
      page
        .locator(".chat-tool-card__widget-host iframe")
        .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("title")));
    const expectedPreviews = ["Preview cv_first", "Preview cv_second"];
    const expectRenderedPreviews = async () => {
      await expect.poll(readPreviews).toEqual(expectedPreviews);
      for (const docId of documentIds) {
        await page
          .locator(`.chat-tool-card__widget-host iframe[title="Preview ${docId}"]`)
          .contentFrame()
          .frameLocator("iframe")
          .getByText(`Rendered ${docId}`, { exact: true })
          .waitFor();
      }
      expect(
        (await gateway.getRequests("canvas.document.view"))
          .map((request) =>
            requireString(requireRecord(request.params).docId, "Canvas document ID"),
          )
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(documentIds);
    };

    await expectRenderedPreviews();
    await expect.poll(() => page.getByText(finalText, { exact: true }).isVisible()).toBe(true);

    await screenshot(page, artifactDir, "before-reload.png");

    await page.reload();
    // Reload reinstalls the in-page mock Gateway and its request ring, so the
    // first startup request in the new document is the synchronization point.
    await gateway.waitForRequest("chat.startup");
    await expectRenderedPreviews();
    await expect.poll(() => page.getByText(finalText, { exact: true }).isVisible()).toBe(true);
    await screenshot(page, artifactDir, "after-reload.png");
  });

  it("keeps multiple live replies after their delayed prompt before history catches up", async () => {
    const artifactDir = proofDirectory("chat-live-final-order");
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const runId = "multi-reply-run";
    const replies = [
      "First part of the current answer.",
      "Second part of the current answer.",
    ] as const;
    const previous = "Previous durable conversation.";
    const prompt = "Please give me both parts.";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.history"],
      methodResponses: {
        "chat.startup": {
          deltaCursor: "before-multi-reply",
          messages: [],
          sessionId: "session:agent:main:main",
          sessionInfo: doneSession(),
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");
    for (const [index, text] of replies.entries()) {
      await gateway.emitGatewayEvent("chat", {
        runId,
        seq: index + 1,
        sessionKey: "main",
        state: "final",
        message: message("assistant", text),
      });
      await page.locator(".chat-thread-inner").getByText(text, { exact: true }).waitFor();
    }
    for (const [id, seq, role, text, idempotencyKey] of [
      ["previous", 10, "user", previous, "previous-run:user"],
      ["current-prompt", 11, "user", prompt, `${runId}:user`],
    ] as const) {
      await gateway.emitGatewayEvent("session.message", {
        message: message(role, text, { __openclaw: { id, seq, idempotencyKey } }),
        messageId: id,
        messageSeq: seq,
        sessionKey: "main",
        session: doneSession(),
      });
      await page.locator(".chat-thread-inner").getByText(text, { exact: true }).waitFor();
    }
    if (artifactDir) {
      await writeFile(
        path.join(artifactDir, "multi-reply-order.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          page.locator(".chat-thread-inner").getByText(replies[1], { exact: true }),
        ]),
      );
    }
    await expectBubbleOrder(page, [previous, prompt, ...replies]);
  });
});
