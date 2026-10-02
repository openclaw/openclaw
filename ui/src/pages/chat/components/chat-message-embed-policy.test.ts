/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderMessageGroup, renderMessageGroupContent } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { renderStreamGroupParts } from "./chat-message-stream.ts";

describe("assistant message embed policy", () => {
  it.each(["persisted", "streaming"] as const)(
    "applies external embed policy changes to an existing %s message",
    (surface) => {
      const host = document.createElement("div");
      const url = "https://example.test/widget";
      const text = `[embed url="${url}" title="Widget" /]\nRead the widget.`;
      const message = { role: "assistant", content: [{ type: "text", text }] };

      for (const allowed of [false, true, false]) {
        const options = { allowExternalEmbedUrls: allowed, embedSandboxMode: "scripts" as const };
        render(
          surface === "streaming"
            ? renderStreamGroupParts(
                [{ kind: "stream", key: "message", text, startedAt: 1, isStreaming: true }],
                options,
                "standalone",
              )
            : renderGroupedMessage(prepareChatMessageRender(message), "message", {
                ...options,
                isStreaming: false,
                showReasoning: false,
              }),
          host,
        );

        const frame = host.querySelector("iframe");
        expect(frame).not.toBeNull();
        expect(frame?.getAttribute("src")).toBe(allowed ? url : null);
        expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
        expect(host.textContent).toContain("Read the widget.");
      }
    },
  );
  it.each([
    { label: "grouped messages", renderGroup: renderMessageGroup },
    { label: "run-frame message contents", renderGroup: renderMessageGroupContent },
  ])("updates the authenticated widget's script policy when $label rerender", ({ renderGroup }) => {
    const container = document.createElement("div");
    onTestFinished(async () => {
      await vi.dynamicImportSettled();
      render(null, container);
    });
    let timestamp = 1000;
    const renderCanvas = (embedSandboxMode: "strict" | "scripts", prepend = false) => {
      const message = {
        role: "assistant",
        id: "assistant-canvas-inline-sandbox-change",
        timestamp: timestamp++,
        content: [
          { type: "text", text: "Inline canvas result." },
          {
            type: "canvas",
            preview: {
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              viewId: "cv_inline_sandbox-change",
              title: "Inline demo",
              url: "/__openclaw__/canvas/documents/cv_inline_sandbox-change/index.html",
              preferredHeight: 360,
            },
          },
        ],
      };
      const messages = prepend
        ? [{ role: "assistant", content: "Earlier reply.", id: "earlier", timestamp: 999 }, message]
        : [message];
      // Use production keys and grouping: recreated messages retain source identity
      // even when their timestamps change or earlier replies are inserted.
      const [group] = groupMessages(buildMessageItems(messages));
      if (group?.kind !== "group") {
        throw new Error("expected a prepared assistant message group");
      }
      render(renderGroup(group, { showReasoning: true, embedSandboxMode }), container);
    };

    renderCanvas("strict");
    expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
    const widget = container.querySelector("openclaw-canvas-widget-view");
    expect(widget).toBeInstanceOf(HTMLElement);
    expect(widget).toMatchObject({
      docId: "cv_inline_sandbox-change",
      title: "Inline demo",
      allowScripts: false,
    });
    expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();

    renderCanvas("scripts");
    expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({ allowScripts: true });

    renderCanvas("strict");
    expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({ allowScripts: false });
    expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();

    renderCanvas("scripts", true);
    expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({ allowScripts: true });
    expect(
      [...container.querySelectorAll(".chat-text")].map((node) => node.textContent?.trim()),
    ).toEqual(["Earlier reply.", "Inline canvas result."]);

    renderCanvas("strict");
    expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({ allowScripts: false });
    expect(container.querySelectorAll(".chat-text")).toHaveLength(1);
  });
});
