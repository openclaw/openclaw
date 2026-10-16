/* @vitest-environment jsdom */

import { createComponent, createSignal, getOwner } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageGroup, MessageGroupContent } from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { StreamGroupParts, type StreamGroupPart } from "./chat-message-stream-view.tsx";

function createEmbedHarness(container: HTMLElement, surface: "persisted" | "streaming") {
  type Props = {
    text: string;
    options: Pick<
      Parameters<typeof GroupedMessage>[0]["options"],
      "allowExternalEmbedUrls" | "embedSandboxMode" | "sessionKey"
    >;
  };
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: Props) => void;
  return {
    render(text: string, options: Props["options"]) {
      const next = { text, options };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal(next);
            update = setProps;
            return surface === "streaming"
              ? createComponent(StreamGroupParts, {
                  get parts(): StreamGroupPart[] {
                    return [
                      {
                        kind: "stream",
                        key: "message",
                        text: props().text,
                        startedAt: 1,
                        isStreaming: true,
                      },
                    ];
                  },
                  get options() {
                    return props().options;
                  },
                  presentation: "standalone",
                })
              : createComponent(GroupedMessage, {
                  get preparation() {
                    return prepareChatMessageRender({
                      role: "assistant",
                      content: [{ type: "text", text: props().text }],
                    });
                  },
                  messageKey: "message",
                  get options() {
                    return { ...props().options, isStreaming: false, showReasoning: false };
                  },
                });
          },
          { container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
    },
  };
}

describe("assistant message embed policy", () => {
  it.each(["persisted", "streaming"] as const)(
    "preserves YouTube playback on refresh and revokes it on policy, source, and session changes in %s messages",
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
      const preview = createEmbedHarness(host, surface);
      onTestFinished(() => {
        preview.unmount();
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
        preview.render(text, options);
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
      expect(await show()).toBe(first);
      expect(first.querySelector("iframe")).toBe(firstFrame);
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
      const preview = createEmbedHarness(host, surface);
      onTestFinished(() => preview.unmount());

      for (const allowed of [false, true, false]) {
        const options = { allowExternalEmbedUrls: allowed, embedSandboxMode: "scripts" as const };
        preview.render(text, options);

        const frame = host.querySelector("iframe");
        expect(frame).not.toBeNull();
        expect(frame?.getAttribute("src")).toBe(allowed ? url : null);
        expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
        expect(host.textContent).toContain("Read the widget.");
      }
    },
  );
  it.each([
    { label: "grouped messages", renderGroup: MessageGroup },
    { label: "run-frame message contents", renderGroup: MessageGroupContent },
  ])("updates the authenticated widget's script policy when $label rerender", ({ renderGroup }) => {
    const container = document.createElement("div");
    type GroupProps = Parameters<typeof MessageGroup>[0];
    let root: ReturnType<typeof mountSolid> | undefined;
    let update: (props: GroupProps) => void;
    onTestFinished(async () => {
      await vi.dynamicImportSettled();
      root?.unmount();
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
      const next = { group, options: { showReasoning: true, embedSandboxMode } };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal<GroupProps>(next);
            update = setProps;
            return createComponent(renderGroup, {
              get group() {
                return props().group;
              },
              get options() {
                return props().options;
              },
            });
          },
          { container },
        );
      }
      flush();
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
