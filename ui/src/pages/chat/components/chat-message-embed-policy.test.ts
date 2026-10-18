/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageGroup, MessageGroupContent } from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { StreamGroupParts, type StreamGroupPart } from "./chat-message-stream-view.tsx";
import { createCanvasPreview } from "./chat-message.test-support.ts";

function createHarness<Props extends object>(Content: (props: Props) => JSX.Element) {
  const host = document.createElement("div");
  let root: ReturnType<typeof mountSolid<Props>> | undefined;
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    root?.dispose();
    host.remove();
    vi.unstubAllGlobals();
  });
  return {
    host,
    render(next: Props) {
      if (root) {
        root.update(next);
      } else {
        root = mountSolid(Content, next, host);
      }
    },
  };
}

function createEmbedHarness(surface: "persisted" | "streaming") {
  type Props = {
    text: string;
    options: Pick<
      Parameters<typeof GroupedMessage>[0]["options"],
      "allowExternalEmbedUrls" | "embedSandboxMode" | "sessionKey"
    >;
  };
  const Content = (props: Props) =>
    surface === "streaming"
      ? createComponent(StreamGroupParts, {
          get parts(): StreamGroupPart[] {
            return [
              { kind: "stream", key: "message", text: props.text, startedAt: 1, isStreaming: true },
            ];
          },
          get options() {
            return props.options;
          },
          presentation: "standalone",
        })
      : createComponent(GroupedMessage, {
          get preparation() {
            return prepareChatMessageRender({
              role: "assistant",
              content: [{ type: "text", text: props.text }],
            });
          },
          messageKey: "message",
          get options() {
            return { ...props.options, isStreaming: false, showReasoning: false };
          },
        });
  return createHarness(Content);
}

it.each(["persisted", "streaming"] as const)(
  "revokes YouTube on policy/session/source changes (%s)",
  async (surface) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { host, render } = createEmbedHarness(surface);
    document.body.append(host);
    const show = async (
      embedSandboxMode: "scripts" | "strict" = "scripts",
      sessionKey = "agent:main:first",
      url = "https://youtu.be/AbCdEfGhI_1",
    ) => {
      render({
        text: `[embed url="${url}" title="Video" /]`,
        options: { allowExternalEmbedUrls: false, embedSandboxMode, sessionKey },
      });
      await vi.dynamicImportSettled();
      const card = host.querySelector("openclaw-youtube-video");
      expect(card).not.toBeNull();
      await card!.updateComplete;
      return card!;
    };
    const play = async (card: HTMLElementTagNameMap["openclaw-youtube-video"]) => {
      const button = card.querySelector<HTMLButtonElement>('button[aria-label="Play Video"]');
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
    let current = reenabled;
    for (const id of ["AbCdEfGhI_1", "JkLmNoPqR_2"]) {
      const frame = await play(current);
      current = await show("scripts", "agent:main:second", `https://youtu.be/${id}`);
      expect(frame.isConnected).toBe(false);
      expect(current.querySelector("iframe")).toBeNull();
    }
    expect(current.querySelector("a")?.href).toBe("https://www.youtube.com/watch?v=JkLmNoPqR_2");
  },
);

it.each(["persisted", "streaming"] as const)(
  "updates external embed policy in %s messages",
  (surface) => {
    const { host, render } = createEmbedHarness(surface);
    const url = "https://example.test/widget";
    const text = `[embed url="${url}" title="Widget" /]\nRead the widget.`;
    for (const allowed of [false, true, false]) {
      render({ text, options: { allowExternalEmbedUrls: allowed, embedSandboxMode: "scripts" } });
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
  const { host: container, render } = createHarness(renderGroup);
  let timestamp = 1000;
  const renderCanvas = (embedSandboxMode: "strict" | "scripts", prepend = false) => {
    const message = {
      role: "assistant",
      id: "canvas",
      timestamp: timestamp++,
      content: [
        { type: "text", text: "Canvas." },
        {
          type: "canvas",
          preview: createCanvasPreview({
            viewId: "cv_test",
            title: "Scoped preview",
            preferredHeight: 320,
          }),
        },
      ],
    };
    const messages = prepend
      ? [{ role: "assistant", content: "Earlier.", id: "earlier", timestamp: 999 }, message]
      : [message];
    // Production grouping must retain identity across timestamp changes and prepends.
    const [group] = groupMessages(buildMessageItems(messages));
    if (group?.kind !== "group") {
      throw new Error("expected an assistant message group");
    }
    render({
      group,
      options: {
        showReasoning: true,
        embedSandboxMode,
        sessionKey: "agent:main:canvas",
        canvasPluginSurfaceUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      },
    });
  };

  let widget: Element | null = null;
  for (const [mode, prepend] of [
    ["strict", false],
    ["scripts", false],
    ["strict", false],
    ["scripts", true],
    ["strict", false],
  ] as const) {
    renderCanvas(mode, prepend);
    widget ??= container.querySelector("openclaw-canvas-widget-view");
    expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
    expect(widget).toBeInstanceOf(HTMLElement);
    expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({
      docId: "cv_test",
      title: "Scoped preview",
      preferredHeight: 320,
      sessionKey: "agent:main:canvas",
      allowScripts: mode === "scripts",
    });
    expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
    expect(
      [...container.querySelectorAll(".chat-text")].map((node) => node.textContent?.trim()),
    ).toEqual(prepend ? ["Earlier.", "Canvas."] : ["Canvas."]);
  }
});
