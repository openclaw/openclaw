/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import * as markdown from "../../../components/markdown.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setAvatarGatewayOrigin } from "../../../lib/identity-avatar-context.ts";
import * as localStorageModule from "../../../local-storage.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import * as chatAvatar from "../chat-avatar.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { buildCachedChatItems } from "../chat-thread.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { renderChatNotice } from "./chat-divider.ts";
import { dismissConfirmedActionPopovers } from "./chat-message-confirmation.ts";
import { renderActivityGroup, renderMessageGroup } from "./chat-message-group.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";
import {
  createAssistantMessage,
  createCanvasPreview,
  createToolResultBlock,
  createAssistantCanvasBlock,
  createUserMessage,
  createToolCall,
  createToolResultMessage,
  prepareHistoryGroups,
  prepareMessageGroup,
  createMediaBlock,
  createAssistantImageMessage,
  createAssistantAudioMessage,
  createAttachmentBlock,
  createMessageGroup,
  createMessageEntry,
  createToolGroup,
  type TestMessage,
  type TestMessageEntry,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import "./chat-detail-panel.ts";

let view: HTMLDivElement;
const localStorageValues = new Map<string, string>();
const mediaSubscribers = new Set<() => void>();
const renderMarkdownHtml = markdown.toSanitizedMarkdownHtml;
const renderStreamingMarkdown = markdown.toStreamingMarkdownParts;
const markdownRenderMock = vi.fn((value: string) => value);
const streamingMarkdownRenderMock = vi.fn((value: string): [string, string] => [
  "",
  `<div class="streaming-markdown">${value}</div>`,
]);

function getSafeLocalStorageMock(): Storage {
  return {
    get length() {
      return localStorageValues.size;
    },
    clear: () => localStorageValues.clear(),
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  };
}

beforeEach(() => {
  view = document.createElement("div");
  vi.spyOn(localStorageModule, "getSafeLocalStorage").mockImplementation(getSafeLocalStorageMock);
  vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation(markdownRenderMock);
  vi.spyOn(markdown, "toStreamingMarkdownParts").mockImplementation(streamingMarkdownRenderMock);
  vi.spyOn(chatAvatar, "renderChatAvatar").mockImplementation(
    (role) => html`<div class="chat-avatar ${role}"></div>`,
  );
});

type RenderMessageGroupOptions = Parameters<typeof renderMessageGroup>[1];
function expectElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

function elementText(selector: string, container: Element = view) {
  return container.querySelector(selector)?.textContent;
}

function expectCanvasWidget(
  container: Element,
  expected: { docId: string; title: string; preferredHeight?: number; sessionKey?: string },
) {
  expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  const widget = expectElement(container, "openclaw-canvas-widget-view", HTMLElement);
  expect(widget).toMatchObject(expected);
  expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
  return widget;
}

function requireFetchCallForUrl(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string) {
  const call = fetchMock.mock.calls.find(([url]) => url === expectedUrl) as
    | [string, RequestInit?]
    | undefined;
  if (!call) {
    throw new Error(`Expected fetch call for ${expectedUrl}`);
  }
  return call;
}

function expectSameOriginGet(init: RequestInit | undefined) {
  expect(init?.credentials).toBe("same-origin");
  expect(init?.method).toBe("GET");
}

function rejectWhenAborted<T>(signal: AbortSignal, rejection: () => Error): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(rejection()), { once: true });
  });
}

function renderTestMessageGroup(
  group: MessageGroup,
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  if (opts.onRequestUpdate) {
    mediaSubscribers.add(opts.onRequestUpdate);
  }
  return renderMessageGroup(group, {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...opts,
  });
}

function renderAssistantMessage(
  message: unknown,
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  renderGroupedMessage(message, "assistant", opts, container);
}

function renderMarkdownAssistant(content: unknown) {
  markdownRenderMock.withImplementation(renderMarkdownHtml, () =>
    renderAssistantMessage(createAssistantMessage(content)),
  );
}

function renderReactiveAssistant(
  message: () => unknown,
  options: Partial<RenderMessageGroupOptions>,
  container: HTMLElement = view,
) {
  const onRequestUpdate = () =>
    renderAssistantMessage(message(), { ...options, onRequestUpdate }, container);
  onRequestUpdate();
}

function renderAssistantMessages(
  messages: unknown[],
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  const group = createMessageGroup(messages[0], "assistant", {
    key: "assistant-group",
    messages: messages.map((message, index) => ({
      key: `assistant-message-${index}`,
      message,
    })),
  });
  render(renderTestMessageGroup(group, opts), container);
}

function renderAssistantMessageEntries(
  entries: TestMessageEntry[],
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  const group = createMessageGroup(entries[0]?.message, "assistant", {
    key: "assistant-group",
    messages: entries,
    timestamp: Date.now(),
  });
  render(renderTestMessageGroup(group, opts), container);
}

function renderGroupedMessage(
  message: unknown,
  role: string,
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  const group = createMessageGroup(message, role, {
    key: `${role}-group`,
    messages: [{ key: `${role}-message`, message }],
  });
  render(renderTestMessageGroup(group, opts), container);
}

describe("cloud workspace conflict transcript messages", () => {
  it.each([
    {
      label: "bounded structured status",
      paths: ["one", "two", "three", "four", "five", "six"].map((name) => `src/${name}.ts`),
      stagedResultRef: "refs/openclaw/worker-results/claim-456",
      totalCount: 7,
    },
    {
      label: "escaped terminal-control filenames",
      paths: ["src/line\nbreak.ts"],
      stagedResultRef: "refs/openclaw/worker-results/claim-control",
      totalCount: undefined,
    },
  ])("renders $label in durable history", ({ paths, stagedResultRef, totalCount }) => {
    renderGroupedMessage(
      {
        role: "custom",
        customType: "cloud-workspace-conflict",
        content: "fallback summary that should not render as plain text",
        details: { paths, stagedResultRef, ...(totalCount === undefined ? {} : { totalCount }) },
        timestamp: 1,
      },
      "custom",
    );
    expect(view.textContent).toContain(stagedResultRef);
    if (totalCount === undefined) {
      expect(elementText(".chat-workspace-conflict-paths code")).toBe("src/line\\u{000a}break.ts");
    } else {
      expect(view.querySelector(".chat-group.workspace-conflict")).not.toBeNull();
      const card = expectElement(view, ".chat-workspace-conflict-event", HTMLDivElement);
      expect(card.textContent).toContain("Cloud result applied with 7 conflicts");
      expect(card.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
      expect(card.textContent).toContain("+2 more paths");
      expect(card.textContent).toContain(stagedResultRef);
      expect(card.querySelector(".chat-text")).toBeNull();
      expect(elementText(".chat-sender-name")).toBe("Cloud workspace");
    }
  });
});

function renderMessageGroups(
  groups: MessageGroup[],
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  render(html`${groups.map((group) => renderTestMessageGroup(group, opts))}`, container);
}

function clearConfirmedActionSkip() {
  localStorageValues.delete("openclaw:skip-rewind-confirm");
}

function stubAnimationFrameQueue() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return () => {
    const pending = callbacks.splice(0);
    for (const callback of pending) {
      callback(performance.now());
    }
  };
}

function getLastCaptureListener(calls: readonly unknown[][], event: string) {
  return (
    calls.findLast(
      ([type, listener, options]) => type === event && options === true && listener,
    )?.[1] ?? null
  );
}

function countCaptureListenerRemovals(
  calls: readonly unknown[][],
  listener: unknown,
  event: string,
) {
  return calls.filter(
    ([type, removedListener, options]) =>
      type === event && options === true && removedListener === listener,
  ).length;
}

function renderConfirmedActionFixture() {
  const container = document.body.appendChild(document.createElement("div"));
  container.dataset.confirmedActionFixture = "true";
  const onAction = vi.fn();
  clearConfirmedActionSkip();
  renderGroupedMessage(
    createUserMessage("hello from user", { timestamp: 1000 }),
    "user",
    { onRewind: onAction },
    container,
  );
  const actionButton = container.querySelector<HTMLButtonElement>(".chat-group-rewind");
  expect(actionButton).toBeInstanceOf(HTMLButtonElement);
  return { actionButton: actionButton!, container, onAction };
}

function openConfirmedAction(actionButton: HTMLButtonElement) {
  actionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function domRect(params: Partial<Pick<DOMRect, "left" | "top" | "width" | "height">>): DOMRect {
  return new DOMRect(params.left ?? 0, params.top ?? 0, params.width ?? 0, params.height ?? 0);
}

function stubConfirmedActionGeometry(params: {
  trigger: { left: number; top: number; width: number; height: number };
  popover: { width: number; height: number };
  viewport: { left?: number; top?: number; width: number; height: number };
}) {
  vi.stubGlobal("innerWidth", params.viewport.width);
  vi.stubGlobal("innerHeight", params.viewport.height);
  vi.stubGlobal("visualViewport", {
    height: params.viewport.height,
    offsetLeft: params.viewport.left ?? 0,
    offsetTop: params.viewport.top ?? 0,
    width: params.viewport.width,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("chat-group-rewind")) {
      return domRect(params.trigger);
    }
    if (this.classList.contains("chat-confirm-popover")) {
      return domRect(params.popover);
    }
    return domRect({});
  });
}

function setupArmedConfirmedAction() {
  const flushAnimationFrames = stubAnimationFrameQueue();
  const addListenerSpy = vi.spyOn(document, "addEventListener");
  const removeListenerSpy = vi.spyOn(document, "removeEventListener");
  const addKeyListenerSpy = vi.spyOn(window, "addEventListener");
  const removeKeyListenerSpy = vi.spyOn(window, "removeEventListener");
  const fixture = renderConfirmedActionFixture();

  openConfirmedAction(fixture.actionButton);
  flushAnimationFrames();

  const outsideClickListener = getLastCaptureListener(addListenerSpy.mock.calls, "click");
  const outsideContextMenuListener = getLastCaptureListener(
    addListenerSpy.mock.calls,
    "contextmenu",
  );
  const escapeListener = getLastCaptureListener(addKeyListenerSpy.mock.calls, "keydown");
  const popover = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
  for (const listener of [outsideClickListener, outsideContextMenuListener, escapeListener]) {
    expect(typeof listener).toBe("function");
  }

  return {
    ...fixture,
    escapeListener,
    outsideClickListener,
    outsideContextMenuListener,
    popover,
    removeKeyListenerSpy,
    removeListenerSpy,
  };
}

function expectConfirmedActionDismissed(params: ReturnType<typeof setupArmedConfirmedAction>) {
  expect(params.popover.isConnected).toBe(false);
  for (const [spy, listener, event] of [
    [params.removeListenerSpy, params.outsideClickListener, "click"],
    [params.removeListenerSpy, params.outsideContextMenuListener, "contextmenu"],
    [params.removeKeyListenerSpy, params.escapeListener, "keydown"],
  ] as const) {
    expect(countCaptureListenerRemovals(spy.mock.calls, listener, event)).toBe(1);
  }
}

async function flushAssistantAttachmentAvailabilityChecks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function mediaTicketPayload(mediaTicket: string, ttlMs = 5 * 60 * 1000) {
  return {
    available: true,
    mediaTicket,
    mediaTicketExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

function toolResultEntry(key: string, ...args: Parameters<typeof createToolResultMessage>) {
  return createMessageEntry(key, createToolResultMessage(...args));
}

function attachmentDownload(container: Element) {
  return container.querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download");
}

function stubObjectUrls(create: () => string) {
  const createObjectURL = vi.fn(create);
  const revokeObjectURL = vi.fn();
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  return { createObjectURL, revokeObjectURL };
}

function mountManagedAudio(
  source: string,
  artifactId: string,
  resolveArtifactDownload: RenderMessageGroupOptions["resolveArtifactDownload"],
) {
  const container = document.body.appendChild(document.createElement("div"));
  renderReactiveAssistant(
    () =>
      createAssistantAudioMessage(source, {
        artifactId,
        fileName: "voice.mp3",
        mimeType: "audio/mpeg",
        playback: "native",
      }),
    { showToolCalls: false, resolveArtifactDownload },
    container,
  );
  return container;
}

function applyNotice(
  host: ReturnType<typeof createHost>,
  seq: number,
  data: Parameters<typeof agentEvent>[3],
  runId = "run-guardian",
  stream: Parameters<typeof agentEvent>[2] = "codex_app_server.guardian",
) {
  handleAgentEvent(host, agentEvent(runId, seq, stream, data));
}

function renderNotices(host: ReturnType<typeof createHost>, runId: string, paneId: string) {
  const items = buildCachedChatItems({
    paneId,
    sessionKey: "main",
    runId,
    messages: [],
    toolMessages: [],
    guardianNotices: host.guardianNotices,
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
  if (!items.length || !items.every((item) => item.kind === "notice")) {
    throw new Error("Expected notice projections");
  }
  render(html`${items.map((item) => renderChatNotice(item))}`, view);
}

afterEach(() => {
  render(nothing, view);
  view.remove();
  // These detached render fixtures own the callbacks a live chat pane normally releases.
  for (const subscriber of mediaSubscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  mediaSubscribers.clear();
  markdownRenderMock.mockClear();
  document.querySelectorAll("[data-confirmed-action-fixture]").forEach((element) => {
    dismissConfirmedActionPopovers(element);
    element.remove();
  });
  clearConfirmedActionSkip();
  setAvatarGatewayOrigin(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grouped chat rendering", () => {
  it.each([
    { customType: "run-failed-before-reply", label: "Error" },
    { customType: "system-notice", label: "System" },
  ])("labels $customType notices as $label", ({ customType, label }) => {
    renderGroupedMessage(
      {
        role: "custom",
        customType,
        content: "Notice details",
        display: true,
        timestamp: Date.now(),
      },
      "custom",
    );
    expect(elementText(".chat-sender-name")).toBe(label);
    expect(view.textContent).toContain("Notice details");
  });

  it("preserves reference links and one duplicate badge in recovered media", () => {
    const fullText =
      "[Before][proof]\n\nMEDIA:https://example.com/comparison.png\n\n[After][proof]\n\n[proof]: https://example.com/proof";
    const fullMessage = createAssistantMessage(fullText, { timestamp: 1000 });
    const message = createAssistantMessage("Loading preview", {
      timestamp: 1000,
      __openclaw: { id: "media-recovery", seq: 1, truncated: true },
    });
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      renderAssistantMessageEntries([{ key: "media-order", message, duplicateCount: 2 }], {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: fullText,
          message: fullMessage,
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
      });
    });
    expect(
      [...view.querySelectorAll(".chat-text a, .chat-message-image")].map((element) =>
        element instanceof HTMLImageElement ? "image" : element.textContent,
      ),
    ).toEqual(["Before", "image", "After"]);
    expect(
      [...view.querySelectorAll<HTMLAnchorElement>(".chat-text a")].map((link) => link.href),
    ).toEqual(["https://example.com/proof", "https://example.com/proof"]);
    expect(view.querySelectorAll(".chat-duplicate-count")).toHaveLength(1);
    expect(view.textContent).not.toContain("Loading preview");
  });

  it("keeps list structure and its duplicate suffix across an assistant image", () => {
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      renderAssistantMessageEntries([
        {
          key: "list-image",
          duplicateCount: 2,
          message: createAssistantMessage(
            "1. First\nMEDIA:https://example.com/first.png\n1. Second",
          ),
        },
      ]);
    });
    const list = expectElement(view, ".chat-text ol", HTMLOListElement);
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(list.querySelector("li:first-child .chat-message-image")).not.toBeNull();
    expect(list.querySelector("li:last-child")?.textContent).toBe("Second\u00a0×2");
    expect(list.querySelector("li:last-child > .chat-duplicate-count")?.textContent).toBe("×2");
  });

  it.each(["thinking"])("suppresses a whole %s region spanning assistant media", (tag) => {
    renderMarkdownAssistant([
      { type: "text", text: `<${tag}>Hidden before` },
      { type: "image", url: "https://example.com/hidden-before.png" },
      { type: "text", text: "Hidden middle" },
      { type: "image", url: "https://example.com/hidden-after.png" },
      { type: "text", text: `Hidden after</${tag}>\n\nVisible answer` },
    ]);
    expect(elementText(".chat-text")?.trim()).toBe("Visible answer");
  });

  it("keeps literal media-marker text distinct from assistant image positions", () => {
    renderMarkdownAssistant(
      "Literal OPENCLAWMEDIASLOT0END\n\nMEDIA:https://example.com/real.png\n\nDone",
    );
    expect(view.textContent).toContain("Literal OPENCLAWMEDIASLOT0END");
    expect(view.textContent).not.toContain("OPENCLAWMEDIASLOTX");
    expect(view.querySelectorAll(".chat-message-image")).toHaveLength(1);
  });

  it("keeps an inline image mounted while the following paragraph streams and completes", () => {
    const renderTurn = (tail: string, isStreaming: boolean) => {
      const message = createAssistantMessage(
        `**Before**\nMEDIA:https://example.com/stream.png\n\n${tail}`,
        { timestamp: 1000 },
      );
      render(
        renderTestMessageGroup(
          createMessageGroup(message, "assistant", { key: "stream-media", isStreaming }),
        ),
        view,
      );
    };
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      streamingMarkdownRenderMock.withImplementation(renderStreamingMarkdown, () => {
        renderTurn("Checking", true);
        const image = expectElement(view, ".chat-message-image", HTMLImageElement);
        expect(expectElement(view, ".chat-bubble", HTMLElement).classList.contains("fade-in")).toBe(
          false,
        );
        expect(expectElement(view, ".chat-group", HTMLElement).dataset.chatRowKey).toBeTruthy();
        renderTurn("Checking the result.", true);
        expect(view.querySelector(".chat-message-image")).toBe(image);
        renderTurn("Checking the result.", false);
        expect(view.querySelector(".chat-message-image")).toBe(image);
        expect(elementText(".chat-text")).toContain("Checking the result.");
      });
    });
  });

  it("uses the visible caption direction when an assistant image comes first", () => {
    renderMarkdownAssistant(
      "MEDIA:https://example.com/preview.png\n\n<thinking>Hidden English</thinking>שלום",
    );
    expect(view.querySelector(".chat-text")?.getAttribute("dir")).toBe("rtl");
    expect(elementText(".chat-text")?.trim()).toBe("שלום");
  });

  it.each([
    { label: "fence", markdown: "Paragraph\n\n```ts\nconst value = 1;\n```", terminal: "pre" },
    {
      label: "compact details",
      markdown: "<details><summary>More</summary>body</details>",
      terminal: "details",
    },
    {
      label: "block details",
      markdown: "<details>\n<summary>More</summary>\n\nbody\n</details>",
      terminal: "details",
    },
    {
      label: "table",
      markdown: "| Name | Value |\n| --- | --- |\n| one | two |",
      terminal: ".markdown-table",
    },
  ])(
    "keeps a duplicate marker outside terminal $label content",
    ({ markdown: markdownText, terminal }) => {
      markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
      renderAssistantMessageEntries([
        {
          key: "assistant-duplicate",
          message: createAssistantMessage(markdownText, { timestamp: 1 }),
          duplicateCount: 3,
        },
      ]);

      const chatText = expectElement(view, ".chat-text", HTMLDivElement);
      const terminalBlock = expectElement(chatText, terminal, HTMLElement);
      expect(terminalBlock.querySelector(".chat-duplicate-count")).toBeNull();
      expect(chatText.querySelector(":scope > .chat-duplicate-count")?.textContent).toBe("×3");
      expect(chatText.querySelector("summary")?.textContent ?? "").not.toContain("×3");
      expect(chatText.querySelector("td:last-child")?.textContent ?? "").not.toContain("×3");
    },
  );

  it("adds Reply to the inline message actions and forwards persisted reply context", () => {
    const onReply = vi.fn();
    renderAssistantMessage(
      createAssistantMessage("Reply with this context.", {
        timestamp: 1000,
        __openclaw: { id: "assistant-entry-1" },
      }),
      { onReply },
    );

    const actions = view.querySelectorAll<HTMLButtonElement>(".chat-group-footer-actions button");
    expect([...actions].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Reply to message",
      "Copy as markdown",
    ]);

    view.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();

    expect(onReply).toHaveBeenCalledWith({
      messageId: "assistant-message",
      senderLabel: "OpenClaw",
      sourceMessageId: "assistant-entry-1",
      text: "Reply with this context.",
    });

    const userContainer = document.createElement("div");
    renderGroupedMessage(
      createUserMessage("User reply context.", {
        timestamp: 1001,
        __openclaw: { id: "user-entry-1" },
      }),
      "user",
      { onReply, userName: "Jason" },
      userContainer,
    );
    userContainer.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();

    expect(onReply).toHaveBeenLastCalledWith({
      messageId: "user-message",
      senderLabel: "Message",
      sourceMessageId: "user-entry-1",
      text: "User reply context.",
    });
  });

  it.each([
    { state: "failed", actionLabel: "Check failure", retry: true, discard: false },
    { state: "unconfirmed", actionLabel: undefined, retry: true, discard: true },
    { state: "waiting-reconnect", actionLabel: undefined, retry: false, discard: true },
  ] as const)(
    "shows a $state footer with its diagnostic and recovery actions ($actionLabel)",
    ({ state, actionLabel, retry: canRetry, discard: canDiscard }) => {
      const onRetryQueuedMessage = vi.fn();
      const onDiscardQueuedMessage = vi.fn();
      renderGroupedMessage(
        createUserMessage("Attempted message", {
          __openclaw: {
            id: "attempted-send",
            kind: "pending-send",
            state,
            error: "Delivery diagnostic",
          },
        }),
        "user",
        {
          onRetryQueuedMessage,
          onDiscardQueuedMessage,
          queuedMessageAction: actionLabel
            ? { id: "attempted-send", label: actionLabel }
            : undefined,
        },
      );

      const status = view.querySelector<HTMLElement>(".chat-send-status");
      expect(status).not.toBeNull();
      expect(status?.title).toBe("Delivery diagnostic");
      const retry = status?.querySelector<HTMLButtonElement>(".chat-send-status__retry");
      expect(Boolean(retry)).toBe(canRetry);
      retry?.click();
      expect(onRetryQueuedMessage.mock.calls).toEqual(canRetry ? [["attempted-send"]] : []);
      const discard = status?.querySelector<HTMLButtonElement>(".chat-send-status__discard");
      if (canDiscard) {
        discard?.click();
        expect(onDiscardQueuedMessage).toHaveBeenCalledWith("attempted-send");
        discard?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        expect(onDiscardQueuedMessage).toHaveBeenCalledTimes(1);
        expect(onRetryQueuedMessage).toHaveBeenCalledTimes(canRetry ? 1 : 0);
      } else {
        expect(discard).toBeNull();
      }
    },
  );

  it("collapses long image-bearing user messages and toggles their disclosure state", () => {
    const collapsedLines = ["Inspect AGENTS.md:188 first.", "a".repeat(1_201)];
    const expandedTail = "Full prompt tail after the disclosure boundary.";
    const markdownContent = [...collapsedLines, expandedTail].join("\n");
    const message = createUserMessage(
      [
        { type: "text", text: markdownContent },
        createMediaBlock({
          url: "data:image/png;base64,cG5n",
          alt: "Sent image",
          width: 640,
          height: 640,
        }),
      ],
      { timestamp: 1001 },
    );
    const onToggleUserMessageExpanded = vi.fn();
    markdownRenderMock
      .mockImplementationOnce(renderMarkdownHtml)
      .mockImplementationOnce(renderMarkdownHtml);

    for (const expanded of [false, true]) {
      renderGroupedMessage(message, "user", {
        isUserMessageExpanded: () => expanded,
        onToggleUserMessageExpanded,
      });
      const disclosure = expectElement(view, ".chat-message-disclosure", HTMLDivElement);
      const toggle = expectElement(
        disclosure,
        ".chat-message-disclosure__toggle",
        HTMLButtonElement,
      );
      const text = expectElement(disclosure, ".chat-text", HTMLDivElement);
      const fileLink = expectElement(text, "a.markdown-file-link", HTMLAnchorElement);
      expect(
        expectElement(view, ".chat-bubble", HTMLDivElement).classList.contains(
          "chat-bubble--with-images",
        ),
      ).toBe(true);
      expect(view.querySelector(".chat-message-image")).not.toBeNull();
      expect(disclosure.classList.contains("is-expanded")).toBe(expanded);
      expect(text.textContent).toContain(expandedTail);
      expect(fileLink.dataset).toMatchObject({ filePath: "AGENTS.md", fileLine: "188" });
      expect(toggle.textContent?.trim()).toBe(expanded ? "Show less" : "Show more");
      expect(toggle.getAttribute("aria-expanded")).toBe(String(expanded));
      if (!expanded) {
        toggle.click();
        expect(onToggleUserMessageExpanded).toHaveBeenCalledWith("user-message:user-message");
      }
    }
  });

  it("hides rewind while the agent is working", () => {
    renderMessageGroups(
      [createMessageGroup({ role: "user", content: "busy", timestamp: 1000 }, "user")],
      { onRewind: vi.fn(), rewindDisabled: true },
    );

    expect(view.querySelector(".chat-group-rewind")).toBeNull();
  });

  it.each([
    {
      name: "places the confirmation below the trigger near the top viewport edge",
      trigger: { left: 20, top: 4, width: 24, height: 24 },
      popover: { width: 200, height: 96 },
      viewport: { width: 320, height: 240 },
      placement: "below",
      top: "34px",
      left: "8px",
    },
    {
      name: "clamps the confirmation inside shifted visual viewports",
      trigger: { left: 620, top: 540, width: 24, height: 24 },
      popover: { width: 200, height: 80 },
      viewport: { left: 320, top: 300, width: 320, height: 240 },
      placement: "above",
      top: "452px",
      left: "432px",
    },
  ])("$name", ({ trigger, popover, viewport, placement, top, left }) => {
    stubConfirmedActionGeometry({ trigger, popover, viewport });
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);

    const element = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
    expect(element.parentElement).toBe(document.body);
    expect(element.dataset.placement).toBe(placement);
    expect(element.style.top).toBe(top);
    expect(element.style.left).toBe(left);
  });

  it("exposes dialog semantics and keeps keyboard focus inside the confirmation", () => {
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);

    const popover = expectElement(document.body, ".chat-confirm-popover", HTMLElement);
    const check = expectElement(popover, ".chat-confirm-popover__check", HTMLInputElement);
    const cancel = expectElement(popover, ".chat-confirm-popover__cancel", HTMLButtonElement);
    const confirm = expectElement(popover, ".chat-confirm-popover__yes", HTMLButtonElement);
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-modal")).toBe("true");
    expect(popover.getAttribute("aria-label")).toBe(
      popover.querySelector(".chat-confirm-popover__text")?.textContent,
    );
    expect(popover.querySelector(".chat-confirm-popover__remember span")?.textContent).toBe(
      "Don't ask again",
    );
    expect(cancel.textContent).toBe("Cancel");
    expect(document.activeElement).toBe(cancel);

    for (const [from, to, shiftKey] of [
      [confirm, check, false],
      [check, confirm, true],
    ] as const) {
      from.focus();
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
        shiftKey,
      });
      from.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(to);
    }
  });

  it.each(["Escape", "Cancel", "Rewind", "outside click"] as const)(
    "dismisses confirmation listeners and transfers focus after %s",
    (action) => {
      const fixture = setupArmedConfirmedAction();
      const outside = action === "outside click";
      const target = outside
        ? document.body.appendChild(document.createElement("button"))
        : expectElement(
            fixture.popover,
            action === "Rewind" ? ".chat-confirm-popover__yes" : ".chat-confirm-popover__cancel",
            HTMLButtonElement,
          );
      const leakedKeydown = vi.fn();
      document.addEventListener("keydown", leakedKeydown);
      try {
        if (outside || action === "Rewind") {
          target.focus();
        }
        const event =
          action === "Escape"
            ? new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
            : new MouseEvent("click", { bubbles: true });
        target.dispatchEvent(event);
        if (action === "Escape") {
          expect(event.defaultPrevented).toBe(true);
          expect(leakedKeydown).not.toHaveBeenCalled();
        }
        expectConfirmedActionDismissed(fixture);
        if (action === "Rewind") {
          expect(fixture.onAction).toHaveBeenCalledTimes(1);
          expect(document.activeElement).not.toBe(fixture.actionButton);
        } else {
          expect(fixture.onAction).not.toHaveBeenCalled();
          expect(document.activeElement).toBe(outside ? target : fixture.actionButton);
        }
      } finally {
        document.removeEventListener("keydown", leakedKeydown);
        if (outside) {
          target.remove();
        }
      }
    },
  );

  it("dismisses only confirmations contained by the requested owner", () => {
    const fixture = setupArmedConfirmedAction();
    const sibling = renderConfirmedActionFixture();
    openConfirmedAction(sibling.actionButton);
    const siblingPopover = [
      ...document.querySelectorAll<HTMLElement>(".chat-confirm-popover"),
    ].find((popover) => popover !== fixture.popover);

    dismissConfirmedActionPopovers(fixture.container);

    expectConfirmedActionDismissed(fixture);
    expect(siblingPopover?.isConnected).toBe(true);
    dismissConfirmedActionPopovers(sibling.container);
  });

  it("dismisses a portaled confirmation when its owner is detached", async () => {
    const fixture = setupArmedConfirmedAction();

    fixture.container.remove();
    await Promise.resolve();

    expectConfirmedActionDismissed(fixture);
  });

  it("does not attach an outside-click listener after owner cleanup before the next frame", () => {
    const flushAnimationFrames = stubAnimationFrameQueue();
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    const removeListenerSpy = vi.spyOn(document, "removeEventListener");
    const addKeyListenerSpy = vi.spyOn(window, "addEventListener");
    const removeKeyListenerSpy = vi.spyOn(window, "removeEventListener");
    const fixture = renderConfirmedActionFixture();

    openConfirmedAction(fixture.actionButton);
    const contextMenuListener = getLastCaptureListener(addListenerSpy.mock.calls, "contextmenu");
    const escapeListener = getLastCaptureListener(addKeyListenerSpy.mock.calls, "keydown");
    expect(typeof contextMenuListener).toBe("function");
    expect(typeof escapeListener).toBe("function");
    dismissConfirmedActionPopovers(fixture.container);
    flushAnimationFrames();

    expect(document.querySelector(".chat-confirm-popover")).toBeNull();
    expect(getLastCaptureListener(addListenerSpy.mock.calls, "click")).toBeNull();
    for (const [spy, listener, event] of [
      [removeListenerSpy, contextMenuListener, "contextmenu"],
      [removeKeyListenerSpy, escapeListener, "keydown"],
    ] as const) {
      expect(countCaptureListenerRemovals(spy.mock.calls, listener, event)).toBe(1);
    }
  });

  it("uses the largest prompt for context and aggregates usage, cache, and nested cost", () => {
    renderAssistantMessages(
      [
        createAssistantMessage("Checking", {
          usage: { input: 100_000, output: 900_000, cost: { total: 0.1234 } },
          timestamp: 1000,
        }),
        createAssistantMessage("Done", {
          usage: { input: 1, output: 1200, cacheRead: 438_400, cacheWrite: 307 },
          model: "example/provider-model",
          timestamp: 1001,
        }),
      ],
      { contextWindow: 1_000_000 },
    );
    expect(elementText(".msg-meta__ctx")).toBe("44% ctx");
    expect([...view.querySelectorAll(".msg-meta__tokens")].map((node) => node.textContent)).toEqual(
      ["↑100k", "↓901.2k"],
    );
    expect([...view.querySelectorAll(".msg-meta__cache")].map((node) => node.textContent)).toEqual([
      "R438.4k",
      "W307",
    ]);
    expect(elementText(".msg-meta__cost")).toContain("$0.12");
  });

  it("dismisses message context when the neighboring reply tooltip opens", async () => {
    vi.useFakeTimers();
    const provider = document.createElement("openclaw-tooltip-provider");
    provider.append(view);
    document.body.append(provider);
    renderAssistantMessage(
      createAssistantMessage("Done", {
        usage: { input: 12_000, output: 300 },
        model: "openai/gpt-5.6-luna",
        timestamp: 1000,
      }),
      { contextWindow: 100_000, onReply: vi.fn() },
    );

    try {
      await Promise.all(
        [...view.querySelectorAll("openclaw-tooltip")].map((tip) => tip.updateComplete),
      );
      const summary = view.querySelector<HTMLElement>(".msg-meta__summary")!;
      summary.click();
      const metadata = summary.closest("openclaw-tooltip")!;
      expect(metadata.hasAttribute("open")).toBe(true);
      const reply = view.querySelector<HTMLButtonElement>(".chat-reply-btn")!;
      reply.focus();
      const replyTooltip = reply.closest("openclaw-tooltip")!;
      // The wrapper owns visibility even while the optional popup is upgrading.
      expect(replyTooltip.hasAttribute("open")).toBe(true);
      expect(metadata.hasAttribute("open")).toBe(false);
    } finally {
      provider.remove();
    }
  });

  it("renders relative and compact dates while clamping clock skew", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 5, 24, 18, 30);
    vi.setSystemTime(now);
    const renderTimestamp = (timestamp: number) => {
      renderAssistantMessage(createAssistantMessage("Done", { timestamp }));
      return elementText(".chat-group-timestamp")?.trim();
    };

    const recent = now - 5 * 60_000;
    expect(renderTimestamp(recent)).toBe("5m ago");
    expect(view.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(recent).toISOString(),
    );
    const oldTimestamp = Date.UTC(2026, 3, 24, 18, 30);
    expect(renderTimestamp(oldTimestamp)).toBe(
      new Date(oldTimestamp).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
    expect(renderTimestamp(now + 30_000)).toBe("just now");

    const nextYear = Date.UTC(2027, 3, 24, 18, 30);
    expect(renderTimestamp(nextYear)).toBe(
      new Date(nextYear).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  });

  it("keeps streaming participant attribution on the shared reply renderer", () => {
    const container = document.createElement("div");
    render(
      renderStreamGroup([
        {
          kind: "stream",
          key: "stream:participant",
          text: "Reviewing the checklist.",
          startedAt: 1,
          isStreaming: true,
          replyToSender: { name: "Alice Chen", identity: { type: "profile", id: "alice" } },
          replyToMessage: {
            key: "prompt",
            message: {
              role: "user",
              content: "Review the release checklist.",
              __openclaw: { id: "prompt" },
            },
          },
        },
      ]),
      container,
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
    expect(elementText(".chat-reply-attribution__name", container)).toBe("Alice Chen");
    expect(container.querySelectorAll(".chat-reply-connector")).toHaveLength(1);
    expect(container.querySelector(".chat-group--reply")).not.toBeNull();
  });

  it("morphs one assistant turn from working status to its terminal recap", () => {
    const message = {
      role: "assistant",
      content: "First result is ready.",
      timestamp: 1_000,
    };

    renderAssistantMessage(message, {
      activeContinuation: {
        parts: [{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }],
        options: {},
      },
    });

    expect(view.querySelectorAll(".chat-group.assistant")).toHaveLength(1);
    expect(view.querySelector(".chat-reading-indicator")).toBeNull();
    expect(view.querySelector(".chat-working-indicator--continuation")).not.toBeNull();
    expect(elementText(".chat-working-indicator__status")).toContain("Working…");
    // The footer row is reserved but empty until the turn settles.
    expect(view.querySelector(".chat-group-footer")?.childElementCount).toBe(0);

    renderAssistantMessage(message, {
      turnRecap: { runtimeMs: 4 * 3_600_000 + 2 * 60_000, outputTokens: 1 },
    });

    expect(view.querySelectorAll(".chat-group.assistant")).toHaveLength(1);
    expect(view.querySelector(".chat-working-indicator")).toBeNull();
    expect(elementText(".chat-turn-recap--continuation")).toContain("Done in 4 hours, 2 minutes");
    expect(elementText(".chat-turn-recap--continuation")).toContain("1 output token");
    expect(view.querySelector(".chat-turn-recap__claw")).toBeNull();
    expect(view.querySelector(".chat-group-footer")).not.toBeNull();
  });

  it("relabels the working indicator while the run waits for approval", () => {
    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
        startupLabel: "Waiting for a response…",
        waitingApproval: true,
        runOutputTokens: 5_500,
      }),
      view,
    );

    expect(elementText(".chat-working-indicator__status")).toContain("Waiting for approval…");
    expect(view.querySelector(".chat-working-indicator__elapsed")).toBeNull();
    expect(elementText(".chat-working-indicator__tokens")).toBe("5.5k output tokens");
  });

  it("keeps streamed assistant content in the guttered group without an avatar", () => {
    render(
      renderStreamGroup(
        [
          {
            kind: "stream",
            key: "stream:s:live",
            text: "reply",
            startedAt: 10,
            isStreaming: true,
          },
          { kind: "reading-indicator", key: "reading", startedAt: 10 },
        ],
        { showAssistantAvatar: false },
      ),
      view,
    );

    const group = view.querySelector(".chat-group.assistant");
    expect(group?.classList.contains("chat-group--working")).toBe(false);
    expect(group?.classList.contains("chat-group--with-footer")).toBe(true);
    expect(view.querySelectorAll(".chat-avatar.assistant")).toHaveLength(0);
    expect(view.querySelector(".chat-group-footer")?.childElementCount).toBe(0);
    expect(view.querySelectorAll(".chat-working-indicator")).toHaveLength(1);
    expect(view.querySelectorAll(".chat-reading-indicator")).toHaveLength(1);
    render(
      renderStreamGroup(
        [
          {
            kind: "stream",
            key: "stream:s:live",
            text: "reply",
            startedAt: 10,
            isStreaming: false,
          },
        ],
        { showAssistantAvatar: false },
      ),
      view,
    );
    expect(view.querySelector(".chat-bubble.streaming")).toBeNull();
    expect(view.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(10).toISOString(),
    );
  });

  it.each([
    {
      label: "qualified local profile",
      metadata: {
        senderId: "profile-buns",
        senderIdentity: { type: "profile", id: "profile-buns" },
      },
      options: { userId: "profile-buns", userName: "Buns" },
      sender: "Buns",
      source: undefined,
      avatar: "DIV",
    },
    {
      label: "authenticated human with CLI provenance",
      metadata: {
        senderId: "profile-1",
        senderName: "Recorded Name",
        senderIdentity: { type: "profile", id: "profile-1" },
        transport: { clients: [{ id: "cli", mode: "cli", displayName: "Task helper" }] },
      },
      options: { userId: "profile-1", userName: "Current Name" },
      sender: "Current Name",
      source: "via CLI (Task helper)",
      avatar: undefined,
    },
    {
      label: "source-only Web and external clients",
      metadata: {
        transport: {
          clients: [
            { id: "openclaw-control-ui", mode: "webchat" },
            { id: "cli", mode: "cli", displayName: "Release helper" },
            { id: "gateway-client", mode: "backend", displayName: "Build helper" },
          ],
        },
      },
      options: {
        avatarPlacement: "gutter",
        userName: "Unrelated Viewer",
        userAvatar: "https://example.test/viewer.png",
      },
      sender: undefined,
      source: "via CLI (Release helper), RPC (Build helper)",
      avatar: null,
    },
  ] satisfies Array<{
    label: string;
    metadata: TestMessage;
    options: Partial<RenderMessageGroupOptions>;
    sender: string | undefined;
    source: string | undefined;
    avatar: "DIV" | null | undefined;
  }>)(
    "keeps sender attribution distinct for $label",
    ({ metadata, options, sender, source, avatar }) => {
      const message = createUserMessage("Follow up on the current task.", {
        timestamp: 1000,
        __openclaw: metadata,
      });
      const group = prepareMessageGroup(createMessageEntry("source-message", message));
      render(renderTestMessageGroup(group, options), view);
      if (sender === undefined) {
        expect(view.querySelector(".chat-sender-name")).toBeNull();
        expect(view.textContent).not.toContain("Unrelated Viewer");
      } else {
        expect(elementText(".chat-group.user .chat-sender-name")).toBe(sender);
      }
      if (avatar === null) {
        expect(view.querySelector(".chat-avatar, .chat-author-avatar")).toBeNull();
      } else if (avatar !== undefined) {
        expect(view.querySelector(".chat-avatar.user")?.tagName).toBe(avatar);
      }
      expect(elementText(".chat-message-source")).toBe(source);
    },
  );

  it("sender provenance links only profiles and does not identify colliding legacy senders as you", () => {
    const navigate = vi.fn();
    const renderSender = (senderId: string, profile = true) => {
      const message = { role: "user", content: "hello", timestamp: 1000 };
      render(
        renderTestMessageGroup(
          createMessageGroup(message, "user", {
            key: `sender-link-${senderId}`,
            senderLabel: "Alice Example",
            sender: {
              id: senderId,
              name: "Alice Example",
              ...(profile ? { identity: { type: "profile" as const, id: senderId } } : {}),
            },
          }),
          {
            userId: "me",
            userName: "Local User",
            personActivity: { basePath: "", navigate },
          },
        ),
        view,
      );
      return view;
    };

    const peer = renderSender("profile-alice");
    const link = peer.querySelector<HTMLAnchorElement>("a.chat-sender-name");
    expect(link?.textContent).toBe("Alice Example");
    expect(link?.getAttribute("href")).toBe("/activity/profile-alice");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("profile-alice", "Alice Example");

    const own = renderSender("me");
    expect(own.querySelector("a.chat-sender-name")).toBeNull();
    expect(own.querySelector(".chat-sender-name")?.textContent).toBe("Local User");
    const legacy = renderSender("me", false);
    expect(legacy.querySelector("a.chat-sender-name")).toBeNull();
    expect(legacy.querySelector(".chat-sender-name")?.textContent).toBe("Alice Example");
    expect(renderSender("profile-alice", false).querySelector("a.chat-sender-name")).toBeNull();
  });

  it("renders multiline system notices as sanitized markdown", () => {
    markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
    render(
      renderChatNotice({
        kind: "notice",
        key: "notice:command",
        icon: "cpu",
        label: "System",
        text: "**first line**\nsecond line\n<img src=x onerror=alert(1)><script>alert(1)</script>",
        timestamp: 1000,
      }),
      view,
    );

    const notice = view.querySelector<HTMLElement>(".chat-notice");
    expect(notice?.querySelector(".chat-divider__title")?.textContent).toBe("System");
    expect(notice?.querySelector("strong")?.textContent).toBe("first line");
    expect(notice?.querySelector("br")).not.toBeNull();
    expect(notice?.textContent).toContain("second line");
    expect(notice?.querySelector("script")).toBeNull();
    expect(notice?.querySelector("img[onerror]")).toBeNull();
  });

  it("renders Codex guardian decisions and warnings in the transcript", () => {
    const host = createHost();
    applyNotice(host, 1, {
      phase: "completed",
      reviewId: "review-approved",
      status: "approved",
      command: "git status --short",
    });
    applyNotice(host, 2, {
      phase: "completed",
      reviewId: "review-denied",
      status: "denied",
      command: "curl https://example.invalid",
      riskLevel: "high",
      rationale: "Command reaches the network.",
    });
    applyNotice(host, 3, {
      phase: "warning",
      message: "Guardian stopped after too many rejected actions.",
    });
    applyNotice(host, 4, {
      phase: "strict_review_required",
    });
    renderNotices(host, "run-guardian", "guardian-render-test");

    const notices = [...view.querySelectorAll<HTMLElement>(".chat-notice")];
    expect(notices).toHaveLength(4);
    expect(notices[0]?.textContent).toContain("Guardian approved git status --short.");
    expect(notices[0]?.classList.contains("danger")).toBe(false);
    expect(notices[1]?.classList.contains("callout")).toBe(true);
    expect(notices[1]?.classList.contains("danger")).toBe(true);
    expect(notices[1]?.getAttribute("role")).toBe("alert");
    expect(notices[1]?.textContent).toContain("Guardian denied");
    expect(notices[1]?.textContent).toContain("curl https://example.invalid · risk: high");
    expect(notices[1]?.textContent).toContain("Command reaches the network.");
    expect(notices[2]?.textContent).toContain("Guardian warning");
    expect(notices[2]?.textContent).toContain("Guardian stopped after too many rejected actions.");
    expect(notices[3]?.classList.contains("callout")).toBe(true);
    expect(notices[3]?.classList.contains("danger")).toBe(true);
    expect(notices[3]?.getAttribute("role")).toBe("alert");
    expect(notices[3]?.textContent).toContain("Guardian review required");
    expect(notices[3]?.textContent).toContain(
      "Guardian is reviewing this action before it can continue.",
    );
  });

  it("correlates strict review replay and terminal decisions by thread and turn", () => {
    const host = createHost();
    const correlation = { threadId: "thread-guardian", reviewId: "review-shared" };
    const strictReview = (seq: number, turnId: string) =>
      applyNotice(host, seq, {
        ...correlation,
        phase: "strict_review_required",
        turnId,
        startedAtMs: 1_787_273_600_000,
      });

    strictReview(1, "turn-1");
    strictReview(2, "turn-1");
    strictReview(3, "turn-2");
    expect(host.guardianNotices).toHaveLength(2);

    applyNotice(host, 4, {
      ...correlation,
      phase: "completed",
      turnId: "turn-1",
      status: "approved",
    });
    expect(host.guardianNotices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approved" }),
        expect.objectContaining({ kind: "strict-review-required" }),
      ]),
    );

    applyNotice(host, 5, {
      ...correlation,
      phase: "completed",
      turnId: "turn-2",
      status: "aborted",
    });
    expect(host.guardianNotices).toEqual([
      expect.objectContaining({ kind: "approved" }),
      expect.objectContaining({ kind: "denied" }),
    ]);
  });

  it("renders configuration warnings as system notices rather than Guardian failures", () => {
    const host = createHost();
    applyNotice(
      host,
      1,
      {
        phase: "warning",
        message: "Custom execution rules were not applied.",
      },
      "run-warning",
      "notice",
    );
    renderNotices(host, "run-warning", "configuration-warning-render-test");

    expect(elementText(".chat-divider__title")).toBe("System");
    expect(view.textContent).toContain("Custom execution rules were not applied.");
    expect(view.textContent).not.toContain("Guardian warning");
  });

  it("falls back to initials when a user avatar image fails", async () => {
    const message = { role: "user", content: "hello", timestamp: 1000 };
    const group = createMessageGroup(message, "user", {
      key: "gravatar-user",
      senderLabel: "alice",
      // A gateway avatar exercises the image tier without third-party requests.
      sender: { id: "alice@example.com", profileAvatarUrl: "/api/users/alice/avatar" },
    });
    render(renderTestMessageGroup(group, { avatarPlacement: "footer" }), view);

    const image = await vi.waitFor(() => {
      const result = view.querySelector<HTMLImageElement>(".chat-author-avatar__image");
      expect(result).not.toBeNull();
      expect(result?.getAttribute("src")).toBe("/api/users/alice/avatar");
      return result!;
    });
    image.dispatchEvent(new Event("error"));
    expect(view.querySelector(".chat-author-avatar")?.classList.contains("is-fallback")).toBe(true);
    expect(elementText(".chat-author-avatar__fallback")?.trim()).toBe("A");
  });

  it("counts one exec and one wait across completed history, live snapshots, and separated activity groups", async () => {
    document.body.append(view);
    const messages: TestMessage[] = [];
    const toolMessages: TestMessage[] = [];
    for (const [index, name] of ["exec", "wait"].entries()) {
      const toolCallId = `call-${name}`;
      const activity = [
        projectAgentToolActivity({ toolCallId, name, phase: "result", isError: false }),
      ];
      const args = name === "exec" ? { command: "echo ready" } : { runId: "cell-1" };
      const call = { type: "toolcall", name, id: toolCallId, arguments: args };
      const result = { type: "toolresult", name, id: toolCallId, text: `${name} finished` };
      messages.push(
        createAssistantMessage([call], { runId: "run-count", timestamp: index * 10 + 1, activity }),
      );
      messages.push(
        createToolResultMessage(toolCallId, name, `${name} finished`, {
          runId: "run-count",
          activity,
          timestamp: index * 10 + 2,
        }),
      );
      toolMessages.push(
        createAssistantMessage([call, result], {
          runId: "run-count",
          activity,
          toolCallId,
          timestamp: index * 10 + 1,
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: true,
        }),
      );
    }
    messages.push(
      createToolResultMessage("call-wait", "wait", "wait finished", {
        runId: "run-count",
        timestamp: 30,
        activity: [
          projectAgentToolActivity({
            toolCallId: "call-wait",
            name: "wait",
            phase: "result",
            isError: false,
          }),
        ],
      }),
    );
    const items = buildCachedChatItems({
      paneId: "counting",
      sessionKey: "main",
      runId: "run-count",
      messages,
      toolMessages,
      streamSegments: [{ text: "Resuming the cell", ts: 8, itemId: "between", runId: "run-count" }],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    const groups = items.filter((item) => item.kind === "group");
    expect(items.filter((item) => item.kind === "stream")).toHaveLength(1);
    render(
      renderActivityGroup(groups, { showReasoning: false, isToolMessageExpanded: () => true }),
      view,
    );
    await settleToolBridges(view);
    expect(elementText(".chat-activity-group__label")?.trim()).toBe(
      "1 command · 1 other operation",
    );
    expect(view.querySelectorAll(".chat-tool-row")).toHaveLength(2);
  });

  it("renders a persisted call with an unknown outcome until its matching result arrives", async () => {
    document.body.append(view);
    const call = createAssistantMessage(
      [createToolCall("orphan", "exec", { command: "check-workspace" })],
      { __openclaw: { id: "orphan-call", runId: "historic-run" } },
    );
    const renderHistory = async (messages: TestMessage[]) => {
      const history = attachHistoryActivity(prepareChatHistoryFixture(messages));
      const items = buildCachedChatItems({
        paneId: "unknown-historic-outcome",
        sessionKey: "main",
        runId: null,
        messages: history.messages,
        toolMessages: [],
        streamSegments: [],
        stream: null,
        streamStartedAt: null,
        showToolCalls: true,
      });
      render(
        renderActivityGroup(
          items.filter((item) => item.kind === "group"),
          {
            showReasoning: false,
            runActive: false,
            isToolMessageExpanded: () => true,
            isToolExpanded: () => true,
          },
        ),
        view,
      );
      await settleToolBridges(view);
      return history;
    };
    const unknown = await renderHistory([call]);
    expect(unknown.activity[0]?.items[0]).toMatchObject({
      phase: "end",
      summary: "Outcome unknown",
    });
    expect(unknown.activity[0]?.items[0]).not.toHaveProperty("status");
    expect(elementText(".chat-activity-group__label")).toBe("1 command · 1 unknown");
    expect(view.querySelector(".chat-tool-row--running")).toBeNull();
    expect(view.textContent).toContain("check-workspace");

    const completed = await renderHistory([
      call,
      createToolResultMessage("orphan", "exec", "Workspace checked.", {
        isError: false,
        __openclaw: { id: "orphan-result", runId: "historic-run" },
      }),
    ]);
    expect(completed.activity[0]?.items[0]).toMatchObject({ phase: "end", status: "completed" });
    expect(elementText(".chat-activity-group__label")).toBe("1 command");
    expect(view.textContent).not.toContain("outcome unknown");
    expect(view.textContent).toContain("Workspace checked.");
    expect(view.querySelectorAll(".chat-tool-row")).toHaveLength(1);
    expect(view.querySelector(".chat-tool-row--running")).toBeNull();
  });

  it("keeps a persisted tool review icon-only until its command activity expands", async () => {
    document.body.append(view);
    const group = createToolGroup("reviewed-tool-group", [
      toolResultEntry("reviewed-tool-message", "call-reviewed", "run_command", "completed", {
        details: {
          approvalReviews: [
            {
              id: "review-1",
              label: "Guardian",
              status: "approved",
              riskLevel: "low",
              userAuthorization: "high",
              rationale: "Narrowly scoped to the requested file.",
            },
          ],
          approvalReviewOutcome: "approved",
        },
        timestamp: 1000,
      }),
    ]);

    renderMessageGroups([group], {
      isToolMessageExpanded: (id) => (id === "activity:reviewed-tool-group" ? false : undefined),
    });
    await settleToolBridges(view);
    expect(
      view.querySelector('.chat-activity-group__review-status[data-outcome="approved"]'),
    ).not.toBeNull();
    expect(view.textContent).not.toContain("Guardian approved");

    renderMessageGroups([group], {
      isToolMessageExpanded: () => true,
      isToolExpanded: () => true,
    });
    await settleToolBridges(view);
    const review = view.querySelector('.chat-tool-review[data-review-status="approved"]');
    expect(review?.textContent).toContain("Guardian approved");
    expect(review?.textContent).toContain("Narrowly scoped to the requested file.");
    expect(view.querySelector(".chat-tool-msg-body")).not.toBeNull();
    expect(view.querySelectorAll(".chat-tool-review")).toHaveLength(1);
  });

  it("keeps aggregate expansion and accessibility ids stable when groups append", () => {
    const groups = [
      createToolGroup("stable-first", [toolResultEntry("stable-1", "call-1", "read_file", "one")]),
      createToolGroup("stable-second", [toolResultEntry("stable-2", "call-2", "read_file", "two")]),
      createToolGroup("stable-third", [
        toolResultEntry("stable-3", "call-3", "read_file", "three"),
      ]),
    ];
    const opts: RenderMessageGroupOptions = {
      showReasoning: true,
      showToolCalls: true,
      isToolMessageExpanded: (id) => id === "activity:stable-first",
    };

    render(renderActivityGroup(groups.slice(0, 2), opts), view);
    const initialSummary = expectElement(view, ".chat-activity-group__summary", HTMLButtonElement);
    const initialBodyId = initialSummary.getAttribute("aria-controls");
    expect(initialSummary.getAttribute("aria-expanded")).toBe("true");
    expect(initialBodyId).toMatch(/^activity-body-[0-9a-f]+$/);
    expect(view.querySelector(`[id="${initialBodyId}"]`)).not.toBeNull();

    render(renderActivityGroup(groups, opts), view);
    const appendedSummary = expectElement(view, ".chat-activity-group__summary", HTMLButtonElement);
    expect(appendedSummary.getAttribute("aria-controls")).toBe(initialBodyId);
    expect(appendedSummary.getAttribute("aria-expanded")).toBe("true");
    expect(view.querySelectorAll(".chat-activity-group__body > .chat-bubble")).toHaveLength(3);
  });

  it("keeps cross-group activity neutral while retaining failed child badges", () => {
    const container = document.createElement("div");
    const failedMessage = (id: string) =>
      createAssistantMessage(
        [
          {
            type: "tool_use",
            id,
            name: "bash",
            input: { command: "run primary" },
          },
          createToolResultBlock(id, "bash", "Primary path failed", { isError: true }),
        ],
        { isError: true },
      );
    const failed = createToolGroup("failed", [
      createMessageEntry("failed-message", failedMessage("call-failed")),
    ]);
    const successful = createToolGroup("successful", [
      createMessageEntry("successful-message", createToolResultMessage("call-ok", "read", "ok")),
    ]);

    render(
      renderActivityGroup([failed, successful], {
        showReasoning: true,
        showToolCalls: true,
      }),
      container,
    );
    const recoveredSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(recoveredSummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(recoveredSummary.getAttribute("aria-expanded")).toBe("false");
    expect(recoveredSummary.getAttribute("aria-label")).toBeNull();
    expect(elementText(".chat-activity-group__label", container)).not.toContain("failed");

    render(
      renderActivityGroup([failed, successful], {
        showReasoning: true,
        showToolCalls: true,
        isToolMessageExpanded: (id) => id === "activity:failed",
      }),
      container,
    );
    expect(container.querySelector(".chat-activity-group__summary--error")).toBeNull();
    expect(container.querySelectorAll(".chat-tool-msg-summary--error")).toHaveLength(0);

    render(
      renderActivityGroup([successful, failed], {
        showReasoning: true,
        showToolCalls: true,
      }),
      container,
    );
    const failedSummary = expectElement(
      container,
      ".chat-activity-group__summary",
      HTMLButtonElement,
    );
    expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
    expect(failedSummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(failedSummary.getAttribute("aria-expanded")).toBe("false");
    expect(failedSummary.getAttribute("aria-label")).toBeNull();
  });

  it("keeps failed activity collapsed with neutral chain chrome", async () => {
    document.body.append(view);
    const onToggleToolMessageExpanded = vi.fn();
    const group = createToolGroup("tool-group", [
      toolResultEntry(
        "tool-message-1",
        "call-1",
        "read_file",
        JSON.stringify({ error: "Read failed" }),
        {
          isError: true,
          timestamp: 1000,
        },
      ),
      toolResultEntry("tool-message-2", "call-2", "run_command", "Command output", {
        timestamp: 1001,
        isError: false,
      }),
    ]);

    renderMessageGroups([group], { onToggleToolMessageExpanded });
    await settleToolBridges(view);
    expect(elementText(".chat-activity-group__label")).toBe("Raw details");
    expect(elementText(".chat-activity-group__summary")).not.toContain("1 failed");

    renderMessageGroups(prepareHistoryGroups([group]), {
      onToggleToolMessageExpanded,
    });
    await settleToolBridges(view);

    expect(view.querySelector(".chat-activity-group.is-open")).toBeNull();
    const activitySummary = expectElement(view, ".chat-activity-group__summary", HTMLButtonElement);
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(activitySummary.getAttribute("aria-label")).toBeNull();
    expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
    expect(activitySummary.textContent).toContain("1 failed");
    expect(view.textContent).not.toContain("Read failed");
    expect(activitySummary.querySelector(".chat-activity-group__badge")).toBeNull();
    expect(view.querySelector(".chat-tool-msg-body")).toBeNull();
    activitySummary.click();

    expect(onToggleToolMessageExpanded).toHaveBeenCalledWith("activity:tool-group", false);
    view.remove();
  });

  it("hides grouped tool activity when tool calls are disabled", () => {
    const group = createToolGroup("tool-group", [
      toolResultEntry("tool-message-1", "call-1", "read_file", "File one", { timestamp: 1000 }),
      toolResultEntry("tool-message-2", "call-2", "run_command", "Command output", {
        timestamp: 1001,
      }),
    ]);

    renderMessageGroups([group], { showToolCalls: false });

    expect(view.querySelector(".chat-activity-group")).toBeNull();
  });

  it("keeps inline tool cards collapsed by default and renders expanded state", async () => {
    document.body.append(view);
    const message = createAssistantMessage(
      [
        createToolCall("call-1", "browser.open", { url: "https://example.com" }),
        createToolResultBlock("call-1", "browser.open", "Opened page", {
          type: "toolresult",
        }),
      ],
      { id: "assistant-1", toolCallId: "call-1" },
    );
    renderAssistantMessage(message, {
      isToolExpanded: () => false,
    });
    await settleToolBridges(view);

    expect(view.querySelector(".chat-tool-msg-body")).toBeNull();

    renderAssistantMessage(message, {
      isToolExpanded: () => true,
    });
    await settleToolBridges(view);

    // Simple object args render as key-value rows; only the output keeps a block.
    const kvRow = view.querySelector(".chat-tool-kv__row");
    expect(kvRow?.querySelector(".chat-tool-kv__key")?.textContent).toBe("url:");
    expect(kvRow?.querySelector(".chat-tool-kv__value")?.textContent).toBe("https://example.com");
    const blocks = Array.from(view.querySelectorAll(".chat-tool-card__block"));
    // Plain output is the block's default content, so it carries no header.
    expect(blocks[0]?.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("keeps top-level tool-name results collapsed", () => {
    markdownRenderMock.mockClear();
    renderAssistantMessage(
      createAssistantMessage("A long tool result that should stay behind the disclosure.", {
        toolName: "bash",
      }),
      { isToolMessageExpanded: () => false },
    );

    expectElement(view, ".chat-bubble--tool-shell", HTMLElement);
    expectElement(view, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(view.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(view.querySelector(".chat-text")).toBeNull();
    expect(markdownRenderMock).not.toHaveBeenCalled();
  });

  it("keeps one readable label for standalone tool results with duplicate names", async () => {
    document.body.append(view);
    const message = createToolResultMessage("call-heartbeat", "heartbeat_respond", [
      {
        type: "tool_result",
        name: "heartbeat_respond",
        text: "Acknowledged",
      },
    ]);

    renderAssistantMessage(message, {
      isToolMessageExpanded: () => false,
    });
    await settleToolBridges(view);

    const summary = expectElement(view, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.textContent?.trim()).toBe("Heartbeat Respond");
    expect(summary.querySelector("[role=img]")?.ariaLabel).toBe("heartbeat_respond");
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("cleans collapsed tool connector copy while preserving expanded raw input", async () => {
    document.body.append(view);
    const message = createAssistantMessage(
      [createToolCall("call-string-tool", "presentation_create", "with Example Deck")],
      { id: "assistant-string-tool", toolCallId: "call-string-tool" },
    );
    renderAssistantMessage(message, {
      isToolExpanded: () => false,
    });
    await settleToolBridges(view);

    // The cleaned string-arg preview is now the primary collapsed label.
    expect(elementText(".chat-tool-msg-summary__label")?.trim()).toBe("Example Deck");
    expect(view.querySelector(".chat-tool-msg-summary__names")).toBeNull();
    expect(elementText(".chat-tool-msg-summary")).not.toContain("with Example Deck");

    renderAssistantMessage(message, {
      isToolExpanded: () => true,
    });
    await settleToolBridges(view);

    expect(elementText(".chat-tool-msg-body")).not.toContain("presentation_create");
    expect(elementText(".chat-tool-card__block code")).toBe("with Example Deck");
  });

  it("renders expanded tool output rows and their json content", async () => {
    document.body.append(view);
    const output = {
      status: "error",
      exitCode: 1,
      error: "Session mode is unavailable for this target.",
      childSessionKey: "agent:test:subagent:abc123",
    };
    const call = createAssistantMessage(
      [createToolCall("call-5", "sessions_spawn", { mode: "session", thread: true })],
      { id: "assistant-5", toolCallId: "call-5" },
    );
    const result = createToolResultMessage(
      "call-5",
      "sessions_spawn",
      JSON.stringify(output, null, 2),
      {
        id: "tool-5",
        role: "tool",
        timestamp: Date.now() + 1,
      },
    );
    renderMessageGroups(
      [createMessageGroup(call, "assistant"), createMessageGroup(result, "tool")],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
      },
    );
    await settleToolBridges(view);

    // The call's simple args render as key-value rows; the error keeps a block.
    const kvRows = Array.from(view.querySelectorAll(".chat-tool-kv__row"));
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
    const blocks = Array.from(view.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool error"]);
    expect(JSON.parse(blocks[0]?.querySelector("code")?.textContent ?? "{}")).toEqual(output);
    expect(
      blocks[0]?.closest(".chat-tool-card")?.querySelector(":scope > .chat-tool-card__outcome")
        ?.textContent,
    ).toBe("Exit code 1");
  });

  it("keeps status-only standalone tool-result summaries neutral until expanded", async () => {
    document.body.append(view);
    const onToggleToolMessageExpanded = vi.fn();
    const groups = [
      createMessageGroup(
        createToolResultMessage(
          "call-status-error",
          "sessions_spawn",
          JSON.stringify({ status: "error" }, null, 2),
          { id: "tool-status-error" },
        ),
        "tool",
      ),
    ];

    renderMessageGroups(groups, {
      isToolMessageExpanded: () => false,
      onToggleToolMessageExpanded,
    });
    await settleToolBridges(view);

    let summary = expectElement(view, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "sessions_spawn",
    );
    summary.click();
    expect(onToggleToolMessageExpanded).toHaveBeenCalledOnce();

    renderMessageGroups(groups, {
      isToolMessageExpanded: () => true,
    });
    await settleToolBridges(view);

    summary = expectElement(view, ".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    // The failure stays recorded: the expanded body closes with the outcome.
    expect(elementText(".chat-tool-card__outcome")).toBe("failed");
    expect(elementText(".chat-tool-msg-body .chat-text pre code")).toBe(
      '{\n  "status": "error"\n}',
    );
    expect(view.querySelector(".chat-tool-msg-body details, .code-block-json-mode")).toBeNull();
    view.remove();
  });

  it("renders an expanded orphan tool result without a nested disclosure", async () => {
    document.body.append(view);
    renderMessageGroups(
      [
        createMessageGroup(
          createToolResultMessage("call-orphan", "read", "Orphan tool output", {
            id: "orphan-tool-result",
          }),
          "tool",
        ),
      ],
      { isToolMessageExpanded: () => true },
    );
    await settleToolBridges(view);

    expect(view.querySelector(".chat-tool-msg-body .chat-tool-msg-summary")).toBeNull();
    expect(view.querySelectorAll(".chat-tool-card__block code")).toHaveLength(1);
    expect(elementText(".chat-tool-card__block code")).toBe("Orphan tool output");
  });

  it("keeps text visible beside an orphan tool-result image", async () => {
    document.body.append(view);
    renderMessageGroups(
      [
        createMessageGroup(
          createToolResultMessage("call-image", "image", [
            { type: "text", text: "Generated image" },
            { type: "image", data: "cG5n", mimeType: "image/png", alt: "Generated preview" },
          ]),
          "tool",
        ),
      ],
      { isToolMessageExpanded: () => true },
    );
    await settleToolBridges(view);

    expect(elementText(".chat-text")).toContain("Generated image");
    expect(view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,cG5n",
    );
    expect(view.querySelector(".chat-tool-msg-body .chat-tool-msg-summary")).not.toBeNull();
  });

  it("renders assistant MEDIA attachments without a strip for an unresolved current reply", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenImage = vi.fn();
    renderAssistantMessage(
      createAssistantMessage(
        "Here is the image.\nMEDIA:https://example.com/photo.png\nMEDIA:https://example.com/voice.ogg",
        {
          id: "assistant-media-inline",
          openclawDelivery: { replyToCurrent: true },
        },
      ),
      { showToolCalls: false, onOpenImage },
      container,
    );

    expect(container.querySelector(".chat-reply-attribution")).toBeNull();
    expect(elementText(".chat-text", container)?.trim()).toBe("Here is the image.");
    expect(expectElement(container, ".chat-message-image", HTMLImageElement).src).toBe(
      "https://example.com/photo.png",
    );
    expectElement(container, ".chat-message-image-button", HTMLButtonElement).click();
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "https://example.com/photo.png",
      title: "photo.png",
    });
    const audioPlayer = expectElement(
      container,
      "openclaw-chat-audio-player",
      HTMLElement,
    ) as HTMLElement & { updateComplete: Promise<unknown> };
    await audioPlayer.updateComplete;
    expect(elementText(".chat-assistant-attachment-card__title", container)).toBe("voice.ogg");
  });

  it("keeps a persisted reply preview busy until its target resolves, then opens it", () => {
    document.body.append(view);
    const onOpenReply = vi.fn();
    const preview = { senderLabel: "Marie", text: "The original answer" };
    const message = createUserMessage("Follow up", {
      __openclaw: { replyToId: "transcript-123", replyToPreview: preview },
    });
    const show = (loading: boolean) =>
      renderGroupedMessage(message, "user", {
        onOpenReply,
        replyNavigationId: loading ? "transcript-123" : null,
        resolveReplyPreview: () =>
          loading
            ? undefined
            : {
                ...preview,
                messageId: "source-message",
                sourceMessageId: "transcript-123",
              },
      });
    show(true);
    const button = expectElement(view, ".chat-reply-attribution__target", HTMLButtonElement);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.click();
    expect(onOpenReply).not.toHaveBeenCalled();
    show(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Replying to Marie");
    expect(button.textContent).not.toContain("The original answer");
    button.click();
    expect(onOpenReply).toHaveBeenCalledWith("transcript-123");
    expect(elementText(".chat-text")?.trim()).toBe("Follow up");
  });

  it("resolves managed transcode audio to an inline player", async () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const ticketedUrl = `${source}?mediaTicket=managed-ticket`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    renderReactiveAssistant(
      () =>
        createAssistantAudioMessage(
          source,
          {
            artifactId,
            fileName: "voice.caf",
            mimeType: "audio/x-caf",
            playback: "transcode",
            sizeBytes: 4_096,
            durationMs: 2_345,
          },
          { id: "assistant-managed-transcode-audio" },
        ),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "must-not-be-forwarded",
        resolveArtifactDownload,
      },
      container,
    );

    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${ticketedUrl}&playback=1`,
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(attachmentDownload(container)?.getAttribute("href")).toBe(ticketedUrl);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
  });

  it("backs off stale managed ticket refreshes and eventually marks them unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    let finishSecondRequest: (() => void) | undefined;
    const resolveArtifactDownload = vi.fn(() => {
      const requestNumber = resolveArtifactDownload.mock.calls.length;
      const result = {
        url: `${source}?mediaTicket=stale-${requestNumber}`,
        expiresAt: new Date(Date.now() + (requestNumber === 1 ? 6_000 : -1_000)).toISOString(),
      };
      if (requestNumber !== 2) {
        return Promise.resolve(result);
      }
      return new Promise<typeof result>((resolve) => {
        finishSecondRequest = () => resolve(result);
      });
    });
    const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAssistantAttachmentAvailabilityChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    finishSecondRequest?.();
    await flushAssistantAttachmentAvailabilityChecks();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      label: "unchanged expiry",
      refreshFails: false,
      retainedTicket: 2,
      beforeExpiry: 4_999,
      untilExpiry: 1,
    },
    {
      label: "longer-lived recovery after a failed refresh",
      refreshFails: true,
      retainedTicket: 3,
      beforeExpiry: 5_000,
      untilExpiry: 15_000,
    },
  ])(
    "retains a managed ticket through refresh exhaustion with $label",
    async ({ refreshFails, retainedTicket, beforeExpiry, untilExpiry }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
      const initialExpiry = Date.now() + 20_000;
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
      const resolveArtifactDownload = vi.fn(async () => {
        const attempt = resolveArtifactDownload.mock.calls.length;
        if (refreshFails && attempt === 2) {
          throw new Error("refresh unavailable");
        }
        return {
          url: `${source}?mediaTicket=short-${attempt}`,
          expiresAt: new Date(
            refreshFails && attempt === 3 ? Date.now() + 20_000 : initialExpiry,
          ).toISOString(),
        };
      });
      const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
      await flushAssistantAttachmentAvailabilityChecks();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAssistantAttachmentAvailabilityChecks();
      if (refreshFails) {
        expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
        expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
        expect(attachmentDownload(container)?.getAttribute("href")).toContain(
          "mediaTicket=short-1",
        );
      }
      await vi.advanceTimersByTimeAsync(10_000);
      await flushAssistantAttachmentAvailabilityChecks();
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expect(attachmentDownload(container)?.getAttribute("href")).toContain(
        `mediaTicket=short-${retainedTicket}`,
      );
      expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
      await vi.advanceTimersByTimeAsync(beforeExpiry);
      await flushAssistantAttachmentAvailabilityChecks();
      expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(untilExpiry);
      await flushAssistantAttachmentAvailabilityChecks();
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    },
  );

  it("does not render an unticketed managed attachment without an artifact resolver", () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    renderAssistantMessage(
      createAssistantAudioMessage(
        source,
        {
          artifactId: `artifact_managed_media_${crypto.randomUUID()}`,
          fileName: "voice.mp3",
          mimeType: "audio/mpeg",
          playback: "native",
        },
        { id: "assistant-managed-media-without-resolver" },
      ),
      { showToolCalls: false },
    );

    expect(view.querySelector("openclaw-chat-audio-player")).toBeNull();
    expect(elementText(".chat-assistant-attachment-card--blocked")).toContain("Unavailable");
  });

  it.each([
    {
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      source: "/home/node/private/bootstrap-secret.mp3",
    },
  ] as const)("keeps server-rejected $code media blocked", async ({ code, reason, source }) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("meta=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      return { ok: true, json: async () => ({ available: false, code, reason }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderReactiveAssistant(
      () =>
        createAssistantMessage(`Unavailable recording\nMEDIA:${source}`, {
          id: `assistant-bootstrap-blocked-${code}`,
        }),
      {
        showToolCalls: false,
        resourceBasePath: "/openclaw",
        assistantAttachmentAuthToken: "session-token",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushAssistantAttachmentAvailabilityChecks();

    await vi.waitFor(() => {
      expect(
        elementText(
          ".chat-assistant-attachment-card--blocked .chat-assistant-attachment-card__status-meta",
        ),
      ).toContain(reason);
    });
    expect(view.querySelector("audio")).toBeNull();
    expect(attachmentDownload(view)).toBeNull();
  });

  describe("omitted historical images", () => {
    it("keeps omitted media visible beside a standalone tool result", () => {
      renderAssistantMessage(
        createToolResultMessage("call-history-image", "read_file", [
          {
            type: "tool_result",
            name: "read_file",
            text: "Read completed",
          },
          { type: "image", omitted: true, bytes: 2048 },
        ]),
        { isToolMessageExpanded: () => false },
      );

      expect(view.querySelector(".chat-tool-msg-summary")).not.toBeNull();
      expect(view.textContent).toContain("Omitted from history");
      expect(view.textContent).toContain("2.0 KB");
    });
  });

  it("renders a video attachment inline and expands it in the lightbox", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onOpenImage = vi.fn();
    const onOpenSidebar = vi.fn();
    const kind = "video";
    const label = "clip.mp4";
    const mimeType = "video/mp4";
    const tag = "openclaw-chat-video-player";
    const source = `https://example.com/${label}`;

    renderAssistantMessage(
      createAssistantMessage([createAttachmentBlock(source, kind, label, mimeType)], {
        id: `assistant-${kind}-${label}-player`,
      }),
      { showToolCalls: false, onOpenImage, onOpenSidebar },
    );

    const player = expectElement(view, tag, HTMLElement) as HTMLElement & {
      label: string;
      mimeType: string;
      onExpand: (src?: string) => void;
      sourceIdentity: string;
      src: string;
    };
    expect(player).toMatchObject({ label, mimeType, sourceIdentity: source, src: source });
    expect(view.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
    player.onExpand(source);
    expect(onOpenImage.mock.lastCall?.[0]).toMatchObject({
      kind: "video",
      originalSrc: source,
      src: source,
      title: label,
    });
    expect(onOpenSidebar).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops checking when local assistant attachment metadata fetch stalls", async () => {
    vi.useFakeTimers();
    const source = `/tmp/openclaw/${crypto.randomUUID()}-stalled.txt`;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    renderReactiveAssistant(
      () =>
        createAssistantMessage(`Local document\nMEDIA:${source}`, {
          id: "assistant-local-media-stalled-metadata",
        }),
      {
        showToolCalls: false,
        resourceBasePath: "/openclaw",
      },
    );

    const card = expectElement(view, ".chat-assistant-attachment-card--compact", HTMLElement);
    const download = expectElement(card, "a[download]", HTMLAnchorElement);
    expect(card.textContent).toContain(source.split("/").at(-1));
    expect(card.querySelector(".skeleton")).toBeNull();
    expect(download.hasAttribute("href")).toBe(false);
    expect(download.getAttribute("aria-disabled")).toBe("true");
    expect(download.tabIndex).toBe(0);

    const expectedMetaUrl = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&meta=1`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, expectedMetaUrl);
    await vi.advanceTimersByTimeAsync(30_001);
    await flushAssistantAttachmentAvailabilityChecks();

    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchInit?.signal?.aborted).toBe(true);
    expect(elementText(".chat-assistant-attachment-card__status-meta")).toContain("Unavailable");
    expect(view.querySelector(".chat-assistant-attachment-card__action-skeleton")).toBeNull();
  });

  it("renders transcript image variants and structured image blocks", async () => {
    const firstSource = `/tmp/openclaw/${crypto.randomUUID()}-first.png`;
    const secondSource = `/tmp/openclaw/${crypto.randomUUID()}-second.jpg`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-transcript") };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const renderUserMedia = (message: unknown) => {
      const rerender = () =>
        renderGroupedMessage(message, "user", {
          showToolCalls: false,
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          onRequestUpdate: rerender,
        });
      rerender();
    };

    renderUserMedia(
      createUserMessage("", {
        id: "user-history-image-octet-stream",
        __openclaw: {
          media: [{ path: firstSource, contentType: "application/octet-stream" }],
        },
      }),
    );
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toContain(`source=${encodeURIComponent(firstSource)}`);

    renderUserMedia(
      createUserMessage("", {
        id: "user-history-images",
        __openclaw: {
          media: [
            { path: firstSource, contentType: "image/png" },
            { path: secondSource, contentType: "application/octet-stream" },
          ],
        },
      }),
    );
    await flushAssistantAttachmentAvailabilityChecks();
    expect(
      [...view.querySelectorAll<HTMLImageElement>(".chat-message-image")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      expect.stringContaining(`source=${encodeURIComponent(firstSource)}`),
      expect.stringContaining(`source=${encodeURIComponent(secondSource)}`),
    ]);

    renderAssistantMessage(
      createAssistantMessage([{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]),
    );
    expect(view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,cG5n",
    );
  });

  it("expires pairing QR images and requests a refresh at the expiry boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:45:00Z"));
    const onRequestUpdate = vi.fn();

    renderAssistantMessage(
      createAssistantMessage([
        {
          type: "openclaw_pairing_qr",
          image_url: "data:image/png;base64,cXJwbmc=",
          alt: "OpenClaw pairing QR code",
          expiresAtMs: Date.now() + 1_000,
        },
      ]),
      { showToolCalls: false, onRequestUpdate },
    );

    const image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,cXJwbmc=");
    expect(image?.getAttribute("alt")).toBe("OpenClaw pairing QR code");
    await vi.advanceTimersByTimeAsync(999);
    expect(onRequestUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    renderAssistantMessage(
      createAssistantMessage([
        {
          type: "openclaw_pairing_qr",
          image_url: "data:image/png;base64,ZXhwaXJlZA==",
          alt: "OpenClaw pairing QR code",
          expiresAtMs: Date.now() - 1,
        },
      ]),
    );
    expect(view.querySelector(".chat-message-image")).toBeNull();
    expect(view.textContent).toContain("Pairing QR expired");
  });

  it.each([
    "media://inbound/nested%2Fphoto.png",
    "media://inbound/%00.png",
    "media://inbound/nested/../photo.png",
    "media://inbound/..",
  ])("does not proxy non-canonical inbound media ref %s", (source) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderGroupedMessage(
      createUserMessage("", {
        id: "user-invalid-inbound-media-ref",
        __openclaw: { media: [{ path: source, contentType: "image/png" }] },
      }),
      "user",
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fetches managed outgoing chat images with auth and requester scope", async () => {
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const objectUrl = "blob:managed-image";
    stubObjectUrls(() => objectUrl);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-auth-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const onOpenImage = vi.fn();
    renderAssistantMessage(
      createAssistantImageMessage(managedChatImageUrl, "Generated image 1", {
        width: 1,
        height: 1,
      }),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "test-auth-token",
        resourceBasePath: "/rosita",
        onOpenImage,
      },
    );

    await vi.waitFor(() => {
      const image = view.querySelector<HTMLImageElement>(".chat-message-image");
      expect(image?.getAttribute("src")).toBe(objectUrl);
      expect(image?.getAttribute("alt")).toBe("Generated image 1");
    });
    const thumbnailUrl = `/rosita${managedChatImageUrl.replace(/\/full$/u, "/thumbnail")}?v=2`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, thumbnailUrl);
    expectSameOriginGet(fetchInit);
    expectElement(view, ".chat-message-image-button", HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(onOpenImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: objectUrl, title: "Generated image 1" }),
      ),
    );
    const activeItem = onOpenImage.mock.calls[0]?.[0];
    activeItem?.release?.();
  });

  it("refreshes a managed attachment ticket while its Files player stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const attachmentId = crypto.randomUUID();
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const artifactId = `artifact_managed_audio_${attachmentId}`;
    const firstTicket = `${source}?mediaTicket=first`;
    const refreshedTicket = `${source}?mediaTicket=refreshed`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce({
        url: firstTicket,
        expiresAt: new Date(Date.now() + 31_000).toISOString(),
      })
      .mockResolvedValueOnce({
        url: refreshedTicket,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    const container = document.body.appendChild(document.createElement("div"));
    let sidebarContent: unknown;
    renderReactiveAssistant(
      () =>
        createAssistantMessage([
          createAttachmentBlock(source, "audio", "clip.mp3", "audio/mpeg", { artifactId }),
        ]),
      {
        showToolCalls: false,
        resolveArtifactDownload,
        onOpenSidebar: (content) => {
          sidebarContent = content;
        },
      },
      container,
    );

    await flushAssistantAttachmentAvailabilityChecks();
    expectElement(container, ".chat-assistant-attachment-card__expand", HTMLButtonElement).click();

    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      attachmentRuntime: unknown;
      updateComplete: Promise<unknown>;
    };
    panel.content = sidebarContent;
    panel.attachmentRuntime = {
      resolveArtifactDownload,
    };
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(firstTicket);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAssistantAttachmentAvailabilityChecks();
    await panel.updateComplete;

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(refreshedTicket);
    panel.remove();
    container.remove();
  });

  it("downloads a managed image from its pure-image actions", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const thumbnailUrl = `${ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail")}&v=2`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const objectUrls = ["blob:thumbnail", "blob:full", "blob:download"];
    stubObjectUrls(() => objectUrls.shift() ?? "blob:extra");
    const imageBlob = new Blob(["png"], { type: "image/png" });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      blob: async () => imageBlob,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const clickedDownloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownloads.push(this.download);
    });
    const container = document.body.appendChild(document.createElement("div"));
    renderAssistantMessage(
      createAssistantImageMessage(source, "Ticketed image", { artifactId }),
      { showToolCalls: false, resolveArtifactDownload },
      container,
    );
    await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl, expect.anything());

    expect(container.querySelectorAll(".chat-image-action")).toHaveLength(1);
    container
      .querySelector("wa-dropdown")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "download" } } }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(clickedDownloads[0]).toBe("Ticketed image.png");

    expect(fetchMock.mock.calls.filter((call: unknown[]) => call[0] === ticketedUrl)).toHaveLength(
      1,
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    container.remove();
  });

  it("falls back when a managed outgoing image body stalls after headers", async () => {
    vi.useFakeTimers();
    const managedChatImageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing managed image signal");
      }
      return {
        ok: true,
        blob: async () =>
          await rejectWhenAborted<Blob>(
            signal,
            () => new DOMException("The operation was aborted.", "AbortError"),
          ),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderAssistantMessage(
      createAssistantImageMessage(managedChatImageUrl, "Generated image body stall", {
        width: 1,
        height: 1,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      `${managedChatImageUrl.replace(/\/full$/u, "/thumbnail")}?v=2`,
    );
    expect(fetchInit?.signal?.aborted).toBe(false);
    expectSameOriginGet(fetchInit);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(view.querySelector(".chat-message-image")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds managed outgoing image blob URLs with least-recently-used eviction", async () => {
    const imageUrls = Array.from(
      { length: 65 },
      () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
    );
    let objectUrlIndex = 0;
    const { createObjectURL, revokeObjectURL } = stubObjectUrls(
      () => `blob:managed-image-${objectUrlIndex++}`,
    );
    let deferEvictedRefetch = false;
    let resolveEvictedRefetch:
      | ((response: { ok: boolean; blob: () => Promise<Blob> }) => void)
      | undefined;
    const response = { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    const fetchMock = vi.fn((url: string) => {
      if (deferEvictedRefetch && url === `${imageUrls[1]?.replace(/\/full$/u, "/thumbnail")}?v=2`) {
        return new Promise<typeof response>((resolve) => {
          resolveEvictedRefetch = resolve;
        });
      }
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderAssistantMessage({
      role: "assistant",
      content: imageUrls.slice(0, 64).map((url, index) => ({
        type: "image",
        url,
        alt: `Generated image ${index + 1}`,
      })),
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(64));

    const recentContainer = document.createElement("div");
    renderAssistantMessage(
      createAssistantMessage([
        createMediaBlock({ url: imageUrls[0], alt: "Recently viewed image" }),
      ]),
      {},
      recentContainer,
    );
    expect(createObjectURL).toHaveBeenCalledTimes(64);

    const createsBeforeOverflow = createObjectURL.mock.calls.length;
    const overflowContainer = document.createElement("div");
    renderAssistantMessage(
      createAssistantMessage([createMediaBlock({ url: imageUrls[64], alt: "Newest image" })]),
      {},
      overflowContainer,
    );
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeOverflow),
    );
    expect(revokeObjectURL).toHaveBeenCalled();

    deferEvictedRefetch = true;
    const evictedContainer = document.createElement("div");
    renderAssistantMessage(
      createAssistantMessage([createMediaBlock({ url: imageUrls[1], alt: "Refetched image" })]),
      {},
      evictedContainer,
    );
    await vi.waitFor(() => expect(resolveEvictedRefetch).toBeTypeOf("function"));

    const createsBeforeRefetch = createObjectURL.mock.calls.length;
    resolveEvictedRefetch?.(response);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeRefetch),
    );
    expect(evictedContainer.querySelector(".chat-message-image")).not.toBeNull();
  });

  it("bounds managed outgoing image miss retention", async () => {
    const imageUrls = Array.from(
      { length: 65 },
      () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
    );
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderAssistantMessage({
      role: "assistant",
      content: imageUrls.map((url, index) => ({
        type: "image",
        url,
        alt: `Missing image ${index + 1}`,
      })),
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length));
    await flushAssistantAttachmentAvailabilityChecks();

    const retryContainer = document.createElement("div");
    renderAssistantMessage(
      createAssistantMessage([
        createMediaBlock({ url: imageUrls[0], alt: "Oldest missing image" }),
      ]),
      {},
      retryContainer,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length + 1));
  });

  it("does not send auth to cross-origin managed-image-looking URLs", () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("cross-origin image URL should not be fetched with Control UI auth");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderAssistantMessage(
      createAssistantImageMessage(
        "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
        "Untrusted image",
      ),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
      },
    );

    const image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image?.getAttribute("src")).toBe(
      "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "canvas-only shortcode",
      content: [{ type: "text", text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]' }],
      overrides: { id: "assistant-canvas-only" },
      options: { showToolCalls: false },
      bubbleSelector: ".chat-bubble",
      docId: "cv_tictactoe",
      title: "Tic-Tac-Toe",
      toolSummary: false,
    },
    {
      label: "lifted canvas beside a flat tool row",
      content: [
        {
          type: "tool_use",
          id: "call-tool-canvas",
          name: "bash",
          input: { command: "render preview" },
        },
        createAssistantCanvasBlock({ suffix: "tool_canvas" }),
      ],
      overrides: { id: "assistant-tool-canvas", toolName: "bash" },
      options: { showToolCalls: true, isToolMessageExpanded: () => true },
      bubbleSelector: ".chat-bubble--tool-shell",
      docId: "cv_inline_tool_canvas",
      title: "Inline demo",
      toolSummary: true,
    },
  ])(
    "renders a $label inside its assistant bubble",
    ({ content, overrides, options, bubbleSelector, docId, title, toolSummary }) => {
      renderAssistantMessage(createAssistantMessage(content, overrides), options);
      const bubble = expectElement(view, bubbleSelector, HTMLElement);
      const widget = expectCanvasWidget(view, { docId, title });
      expect(bubble.contains(widget)).toBe(true);
      if (toolSummary) {
        expect(view.querySelector(".chat-tool-msg-summary")).not.toBeNull();
      }
    },
  );

  it("opens only safe assistant image URLs in the lightbox", () => {
    const onOpenImage = vi.fn();
    const renderAssistantImage = (url: string) =>
      renderAssistantMessage(createAssistantMessage([{ type: "image_url", image_url: { url } }]), {
        onOpenImage,
      });

    renderAssistantImage("https://example.com/cat.png");
    let image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "https://example.com/cat.png",
      title: "Image",
    });

    onOpenImage.mockClear();
    renderAssistantImage("javascript:alert(1)");
    image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).not.toHaveBeenCalled();

    renderAssistantImage("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />");
    image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toBeInstanceOf(HTMLImageElement);
    image!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenImage).not.toHaveBeenCalled();
  });

  it("preserves widget identity and updates script policy across sandbox modes", () => {
    const message = createAssistantMessage(
      [
        { type: "text", text: "Rendered inline." },
        {
          type: "canvas",
          preview: createCanvasPreview({
            viewId: "cv_inline_scoped",
            title: "Scoped preview",
            preferredHeight: 320,
          }),
        },
      ],
      { id: "assistant-scoped-canvas" },
    );
    const options = {
      canvasPluginSurfaceUrl: "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      sessionKey: "agent:main:canvas",
    };
    renderAssistantMessage(message, options);
    const widget = expectCanvasWidget(view, {
      docId: "cv_inline_scoped",
      title: "Scoped preview",
      preferredHeight: 320,
      sessionKey: options.sessionKey,
    });
    expect(widget).toMatchObject({ allowScripts: true });

    renderAssistantMessage(message, { ...options, embedSandboxMode: "strict" });
    expect(view.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    expect(widget).toMatchObject({ allowScripts: false });
    expect(view.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
  });

  it("opens generic tool details instead of a canvas preview from tool rows", async () => {
    document.body.append(view);
    const onOpenSidebar = vi.fn();
    const canvas = createAssistantCanvasBlock({
      suffix: "sidebar",
      title: "Sidebar demo",
      url: "https://example.com/canvas",
      preferredHeight: 420,
      presentationTarget: "tool_card",
    });
    renderGroupedMessage(
      createToolResultMessage("call-artifact-sidebar", "canvas_render", canvas.rawText),
      "tool",
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
        onOpenSidebar,
      },
    );
    await settleToolBridges(view);
    expectElement(view, ".chat-tool-card__action-btn", HTMLButtonElement).click();
    expect(view.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(onOpenSidebar).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool-output" }));
  });

  function renderAssistantDisclosureActionFixture(
    options: Partial<RenderMessageGroupOptions> = {},
  ) {
    const preview = "Assistant preview\n...(truncated)...";
    const fullMessage = "Complete assistant message beyond the transcript preview.";
    renderAssistantMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: preview }],
        __openclaw: { id: "assistant-disclosure-actions", seq: 1, truncated: true },
      },
      {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: fullMessage,
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
        ...options,
      },
    );
    return { container: view, fullMessage, preview };
  }

  it("keeps loaded assistant thinking private while bounding reply context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const onReply = vi.fn();
    const visibleMessage = `${"a".repeat(499)}😀 full loaded answer`;
    const { container } = renderAssistantDisclosureActionFixture({
      onReply,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>private loaded reasoning</thinking>${visibleMessage}`,
        revision: 1,
      }),
    });

    container
      .querySelector<HTMLButtonElement>(".chat-group-footer-actions .chat-copy-btn")
      ?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(visibleMessage));

    container
      .querySelector<HTMLButtonElement>(
        '.chat-group-footer-actions [aria-label="Reply to message"]',
      )
      ?.click();
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: "a".repeat(499) }));
    expect(container.querySelector<HTMLElement>(".chat-bubble")?.dataset.messageText).toBe(
      visibleMessage,
    );
  });

  it("does not restore a disclosure control for hidden-only loaded assistant text", () => {
    const onReply = vi.fn();
    const onToggleAssistantMessageExpanded = vi.fn();
    const privateThinking = "private expanded reasoning only";
    const { container, preview } = renderAssistantDisclosureActionFixture({
      onReply,
      onToggleAssistantMessageExpanded,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>${privateThinking}</thinking>`,
        revision: 1,
      }),
    });

    expect(elementText(".chat-text", container)?.trim()).toBe("");
    expect(container.textContent).not.toContain(privateThinking);
    expect(container.textContent).not.toContain(preview);
    expect(container.querySelector(".chat-group-footer-actions .chat-copy-btn")).toBeNull();
    expect(container.querySelector('[aria-label="Reply to message"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>(".chat-bubble")?.hasAttribute("data-message-text"),
    ).toBe(false);

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it("admits one full-message load for repeated source projections in a group", () => {
    const previews = ["First projection", "Updated projection"];
    let loading = false;
    const onToggleAssistantMessageExpanded = vi.fn(() => {
      loading = true;
    });
    renderAssistantMessages(
      previews.map((text) =>
        createAssistantMessage(text, {
          __openclaw: { id: "shared-source", truncated: true },
        }),
      ),
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () =>
          loading ? { status: "loading", revision: 1 } : undefined,
        onToggleAssistantMessageExpanded,
      },
    );

    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledTimes(1);
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("shared-source");
    expect([...view.querySelectorAll(".chat-text")].map((element) => element.textContent)).toEqual(
      previews,
    );
  });

  it("retries a failed full-message load while attempts remain", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantDisclosureActionFixture({
      getAssistantMessageExpansion: () => ({ status: "error", revision: 2 }),
      onToggleAssistantMessageExpanded,
    });
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("assistant-disclosure-actions");
  });

  it("does not fetch full content for mirrored message-tool replies", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: "mirrored text\n...(truncated)..." }],
        openclawMessageToolMirror: { toolName: "message", toolCallId: "call-1" },
        __openclaw: { id: "msg-tool-result", seq: 2, truncated: true },
      },
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        onToggleAssistantMessageExpanded,
      },
    );

    expect(view.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it("projects oversized history rows through regular and grouped tool bubbles", () => {
    const rawMarker = "[chat.history omitted: message too large]";
    const notice = "This message is too large to display here.";
    const regularContainer = document.createElement("div");
    renderGroupedMessage(
      {
        role: "user",
        content: [{ type: "text", text: rawMarker }],
        __openclaw: { id: "oversized-user", truncated: true, reason: "oversized" },
      },
      "user",
      {},
      regularContainer,
    );

    const regularBubble = expectElement(regularContainer, ".chat-bubble", HTMLElement);
    expect(regularBubble.textContent).toContain(notice);
    expect(regularBubble.textContent).not.toContain(rawMarker);
    expect(regularBubble.dataset.messageText).toBe(notice);

    const groupedContainer = document.createElement("div");
    const group = createToolGroup("oversized-tool-group", [
      toolResultEntry("oversized-tool-1", "call-1", "read_file", rawMarker, {
        __openclaw: { id: "oversized-tool-1", truncated: true, reason: "oversized" },
      }),
      toolResultEntry("oversized-tool-2", "call-2", "run_command", rawMarker, {
        __openclaw: { id: "oversized-tool-2", truncated: true, reason: "oversized" },
      }),
    ]);
    renderMessageGroups(
      [group],
      {
        isToolMessageExpanded: (id) => id === "activity:oversized-tool-group",
      },
      groupedContainer,
    );

    const groupedBubbles = [
      ...groupedContainer.querySelectorAll<HTMLElement>(
        ".chat-activity-group__body > .chat-bubble",
      ),
    ];
    expect(groupedBubbles).toHaveLength(2);
    expect(groupedBubbles.map((bubble) => bubble.dataset.messageText)).toEqual([notice, notice]);
    expect(groupedContainer.textContent).not.toContain(rawMarker);
  });

  it("keeps the oversized notice visible when assistant recovery exhausts", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        __openclaw: {
          id: "oversized-assistant-error",
          truncated: true,
          reason: "oversized",
        },
      },
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({ status: "error", revision: 6 }),
        onToggleAssistantMessageExpanded,
      },
    );

    expect(elementText(".chat-text")).toContain("This message is too large to display here.");
    expect(view.textContent).not.toContain("[chat.history omitted");
    expect(elementText(".chat-message-load-error")).toContain("Could not load the full message.");
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
    expectElement(view, ".chat-message-load-error__retry", HTMLButtonElement).click();
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("oversized-assistant-error");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
