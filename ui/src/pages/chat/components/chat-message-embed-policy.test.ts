/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { stubTargetRetainingObserver } from "../../../test-helpers/resize-observer.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageGroup, MessageGroupContent } from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { StreamGroupParts, type StreamGroupPart } from "./chat-message-stream-view.tsx";
import { createCanvasPreview } from "./chat-message.test-support.ts";

function createEmbedHarness(container: HTMLElement, surface: "persisted" | "streaming") {
  type Props = {
    text: string;
    options: Pick<
      Parameters<typeof GroupedMessage>[0]["options"],
      "allowExternalEmbedUrls" | "embedSandboxMode" | "sessionKey" | "mediaReadAllowed"
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
  let root: ReturnType<typeof mountSolid<Props>> | undefined;
  return {
    render(text: string, options: Props["options"]) {
      const next = { text, options };
      if (root) {
        root.update(next);
      } else {
        root = mountSolid(Content, next, container);
      }
    },
    unmount() {
      root?.dispose();
    },
  };
}

describe("assistant message embed policy", () => {
  it.each(["persisted", "streaming"] as const)(
    "holds saved %s embeds until live resource admission",
    async (surface) => {
      const host = document.body.appendChild(document.createElement("div"));
      const preview = createEmbedHarness(host, surface);
      onTestFinished(() => {
        preview.unmount();
        host.remove();
      });
      const url = "https://widget.example.test/saved";
      const text = `[embed url="${url}" title="Saved widget" /]\nSaved conversation text.`;
      for (const mediaReadAllowed of [false, true, false]) {
        preview.render(text, { allowExternalEmbedUrls: true, mediaReadAllowed });
        await vi.dynamicImportSettled();
        await waitForSolid(() => {
          expect(host.querySelector("iframe")?.getAttribute("src") ?? null).toBe(
            mediaReadAllowed ? url : null,
          );
          expect(host.textContent).toContain("Saved conversation text.");
        });
      }
    },
  );

  it.each(["persisted", "streaming"] as const)(
    "preserves YouTube playback on refresh and revokes it on policy, source, and session changes in %s messages",
    async (surface) => {
      stubTargetRetainingObserver("ResizeObserver");
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
        const card = host.querySelector<HTMLElement>("openclaw-youtube-video");
        expect(card).not.toBeNull();
        flush();
        return card!;
      };
      const play = async (card: HTMLElement) => {
        const button = card.querySelector<HTMLButtonElement>(
          'button[aria-label="Play Synthetic video"]',
        );
        expect(button).not.toBeNull();
        button!.click();
        flush();
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
  ])(
    "updates the authenticated widget's script policy when $label rerender",
    async ({ renderGroup }) => {
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => container.remove());
      type GroupProps = Parameters<typeof MessageGroup>[0];
      const { gateway } = createApplicationGateway();
      const sessions = createTestSessionCapability(gateway);
      const context = createContext(gateway, sessions);
      onTestFinished(disposeSidebarContextLifecycles);
      const CanvasGroup = (props: GroupProps) =>
        createComponent(ApplicationProvider, {
          value: context,
          host: container,
          get children() {
            return createComponent(renderGroup, props);
          },
        });
      let root: ReturnType<typeof mountSolid<GroupProps>> | undefined;
      onTestFinished(async () => {
        await vi.dynamicImportSettled();
        root?.dispose();
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
              preview: createCanvasPreview({
                viewId: "cv_inline_sandbox-change",
                title: "Scoped preview",
                preferredHeight: 320,
              }),
            },
          ],
        };
        const messages = prepend
          ? [
              { role: "assistant", content: "Earlier reply.", id: "earlier", timestamp: 999 },
              message,
            ]
          : [message];
        // Use production keys and grouping: recreated messages retain source identity
        // even when their timestamps change or earlier replies are inserted.
        const [group] = groupMessages(buildMessageItems(messages));
        if (group?.kind !== "group") {
          throw new Error("expected a prepared assistant message group");
        }
        const next = {
          group,
          options: {
            showReasoning: true,
            embedSandboxMode,
            sessionKey: "agent:main:canvas",
            canvasPluginSurfaceUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
          },
        };
        if (root) {
          root.update(next);
        } else {
          root = mountSolid(CanvasGroup, next, container);
        }
      };

      renderCanvas("strict");
      await waitForSolid(() =>
        expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1),
      );
      const widget = container.querySelector("openclaw-canvas-widget-view");
      expect(widget).toBeInstanceOf(HTMLElement);
      expect(widget).toMatchObject({
        docId: "cv_inline_sandbox-change",
        title: "Scoped preview",
        preferredHeight: 320,
        sessionKey: "agent:main:canvas",
        allowScripts: false,
      });
      expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();

      for (const [mode, prepend] of [
        ["scripts", false],
        ["strict", false],
        ["scripts", true],
        ["strict", false],
      ] as const) {
        renderCanvas(mode, prepend);
        expect(container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
        expect(widget).toMatchObject({ allowScripts: mode === "scripts" });
        expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
        expect(
          [...container.querySelectorAll(".chat-text")].map((node) => node.textContent?.trim()),
        ).toEqual(
          prepend ? ["Earlier reply.", "Inline canvas result."] : ["Inline canvas result."],
        );
      }
    },
  );
});
