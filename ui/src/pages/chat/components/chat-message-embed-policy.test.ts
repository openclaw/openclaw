/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { solidContent } from "../../../lit/solid-content.tsx";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderMessageGroup, renderMessageGroupContent } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { StreamGroupParts } from "./chat-message-stream-view.tsx";

describe("assistant message embed policy", () => {
  it.each(["persisted", "streaming"] as const)(
    "revokes YouTube playback on policy, source, and session changes in %s messages",
    async (surface) => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      const host = document.createElement("div");
      document.body.append(host);
      onTestFinished(() => {
        render(null, host);
        host.remove();
        vi.unstubAllGlobals();
      });
      const show = async (
        embedSandboxMode: "scripts" | "strict" = "scripts",
        sessionKey = "agent:main:first",
        url = "https://youtu.be/AbCdEfGhI_1",
      ) => {
        const text = `[embed url="${url}" title="Synthetic video" /]`;
        const options = { allowExternalEmbedUrls: false, embedSandboxMode, sessionKey };
        render(
          surface === "streaming"
            ? solidContent(StreamGroupParts, {
                parts: [{ kind: "stream", key: "message", text, startedAt: 1, isStreaming: true }],
                options,
                presentation: "standalone",
              })
            : renderGroupedMessage(
                prepareChatMessageRender({ role: "assistant", content: [{ type: "text", text }] }),
                "message",
                { ...options, isStreaming: false, showReasoning: false },
              ),
          host,
        );
        await vi.dynamicImportSettled();
        const card = host.querySelector("openclaw-youtube-video");
        expect(card).not.toBeNull();
        await card!.updateComplete;
        return card!;
      };
      const play = async (card: HTMLElementTagNameMap["openclaw-youtube-video"]) => {
        const button = card.querySelector<HTMLButtonElement>(
          'button[aria-label="Play Synthetic video"]',
        );
        expect(button).not.toBeNull();
        button!.click();
        await card.updateComplete;
        const frame = card.querySelector("iframe");
        expect(frame).toBeInstanceOf(HTMLIFrameElement);
        return frame!;
      };

      const first = await show();
      expect(first.querySelector("iframe")).toBeNull();
      const firstFrame = await play(first);
      await show("strict");
      expect(firstFrame.isConnected).toBe(false);
      expect(first.querySelector("button")).toBeNull();
      expect(first.querySelector("a")?.href).toBe("https://www.youtube.com/watch?v=AbCdEfGhI_1");

      const reenabled = await show();
      expect(reenabled.querySelector("iframe")).toBeNull();
      const reenabledFrame = await play(reenabled);
      const otherSession = await show("scripts", "agent:main:second");
      expect(reenabledFrame.isConnected).toBe(false);
      expect(otherSession.querySelector("iframe")).toBeNull();

      const sessionFrame = await play(otherSession);
      const otherSource = await show(
        "scripts",
        "agent:main:second",
        "https://youtu.be/JkLmNoPqR_2",
      );
      expect(sessionFrame.isConnected).toBe(false);
      expect(otherSource.querySelector("iframe")).toBeNull();
      expect(otherSource.querySelector("a")?.href).toBe(
        "https://www.youtube.com/watch?v=JkLmNoPqR_2",
      );
    },
  );

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
            ? solidContent(StreamGroupParts, {
                parts: [{ kind: "stream", key: "message", text, startedAt: 1, isStreaming: true }],
                options,
                presentation: "standalone",
              })
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
