/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { For, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import * as markdown from "../../../components/markdown.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setAvatarGatewayOrigin } from "../../../lib/identity-avatar-context.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import * as chatAvatar from "../chat-avatar-view.tsx";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { buildCachedChatItems } from "../chat-thread.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { ChatNotice } from "./chat-divider.tsx";
import {
  ActivityGroup,
  MessageGroup as MessageGroupView,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
import { managedSource } from "./chat-message-media.test-helpers.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { StreamGroup } from "./chat-message-stream-view.tsx";
import {
  createAssistantMessage,
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
import "./chat-detail-panel.tsx";

let view: HTMLDivElement;
const mediaSubscribers = new Set<object>();
const renderMarkdownHtml = markdown.toSanitizedMarkdownHtml;
const renderStreamingMarkdown = markdown.toStreamingMarkdownParts;
const markdownRenderMock = vi.fn((value: string) => value);
const streamingMarkdownRenderMock = vi.fn((value: string): [string, string] => [
  "",
  `<div class="streaming-markdown">${value}</div>`,
]);

function TestAvatar(props: { role: string }) {
  return <div class={`chat-avatar ${props.role}`} />;
}

beforeEach(() => {
  view = document.createElement("div");
  vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation(markdownRenderMock);
  vi.spyOn(markdown, "toStreamingMarkdownParts").mockImplementation(streamingMarkdownRenderMock);
  vi.spyOn(chatAvatar, "ChatAvatar").mockImplementation(TestAvatar);
});

type RenderMessageGroupOptions = NativeMessageGroupOptions;
type MessageFixture =
  | { kind: "group"; props: Parameters<typeof MessageGroupView>[0] }
  | { kind: "activity"; props: Parameters<typeof ActivityGroup>[0] }
  | { kind: "stream"; props: Parameters<typeof StreamGroup>[0] }
  | { kind: "notice"; props: Parameters<typeof ChatNotice>[0] };
const messageMounts = new Map<
  HTMLElement,
  ReturnType<typeof mountSolid<{ values: MessageFixture[] }>>
>();

function MessageFixtureView(props: { value: MessageFixture }) {
  const group = () => (props.value.kind === "group" ? props.value.props : undefined);
  const activity = () => (props.value.kind === "activity" ? props.value.props : undefined);
  const stream = () => (props.value.kind === "stream" ? props.value.props : undefined);
  const notice = () => (props.value.kind === "notice" ? props.value.props : undefined);
  return (
    <>
      <Show when={group()}>{(value) => <MessageGroupView {...value()} />}</Show>
      <Show when={activity()}>{(value) => <ActivityGroup {...value()} />}</Show>
      <Show when={stream()}>{(value) => <StreamGroup {...value()} />}</Show>
      <Show when={notice()}>{(value) => <ChatNotice {...value()} />}</Show>
    </>
  );
}

function MessageFixtures(props: { values: MessageFixture[] }) {
  return (
    <For each={props.values} keyed={false}>
      {(value) => <MessageFixtureView value={value()} />}
    </For>
  );
}

function render(value: MessageFixture | MessageFixture[], container: HTMLElement = view) {
  const values = Array.isArray(value) ? value : [value];
  const existing = messageMounts.get(container);
  if (existing) {
    existing.update({ values });
  } else {
    messageMounts.set(container, mountSolid(MessageFixtures, { values }, container));
  }
}

function renderActivityGroup(
  groups: Parameters<typeof ActivityGroup>[0]["groups"],
  options: RenderMessageGroupOptions,
) {
  render({ kind: "activity", props: { groups, options, presentation: "standalone" } });
}

function renderStreamGroup(
  parts: Parameters<typeof StreamGroup>[0]["parts"],
  options: Parameters<typeof StreamGroup>[0]["options"] = {},
  container: HTMLElement = view,
) {
  render({ kind: "stream", props: { parts, options } }, container);
}

function renderChatNotice(item: Parameters<typeof ChatNotice>[0]["item"]): MessageFixture {
  return { kind: "notice", props: { item } };
}
function requireElement<T extends Element>(
  selector: string,
  constructor: new () => T,
  container: Element = view,
): T {
  const found = container.querySelector<T>(selector);
  expect(found).toBeInstanceOf(constructor);
  return expectDefined(found, selector);
}

function element(selector: string, container: Element = view) {
  return container.querySelector<HTMLElement>(selector);
}

function elements<T extends Element = HTMLElement>(selector: string, container: Element = view) {
  return Array.from(container.querySelectorAll<T>(selector));
}

function elementText(selector: string, container: Element = view) {
  return element(selector, container)?.textContent;
}

function expectCount(selector: string, count: number) {
  expect(elements(selector)).toHaveLength(count);
}

function expectAbsent(...selectors: string[]) {
  for (const selector of selectors) {
    expect(element(selector), selector).toBeNull();
  }
}

function expectPresent(...selectors: string[]) {
  for (const selector of selectors) {
    expect(element(selector), selector).not.toBeNull();
  }
}

function expectCanvasWidget(
  container: Element,
  expected: { docId: string; title: string; preferredHeight?: number; sessionKey?: string },
) {
  expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  const widget = requireElement("openclaw-canvas-widget-view", HTMLElement, container);
  expect(widget).toMatchObject(expected);
  expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
  return widget;
}

function requireFetchCallForUrl(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string) {
  const call = fetchMock.mock.calls.find(([url]) => url === expectedUrl) as
    | [string, RequestInit?]
    | undefined;
  return expectDefined(call, `fetch call for ${expectedUrl}`);
}

function expectSameOriginGet(init: RequestInit | undefined) {
  expect(init).toMatchObject({ credentials: "same-origin", method: "GET" });
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
  if (opts.mediaOwner) {
    mediaSubscribers.add(opts.mediaOwner);
  }
  const options = {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...opts,
  };
  return { kind: "group", props: { group, options } } satisfies MessageFixture;
}

function renderAssistantMessage(
  message: unknown,
  opts: Partial<RenderMessageGroupOptions> = {},
  container: HTMLElement = view,
) {
  renderGroupedMessage(message, "assistant", opts, container);
}

async function renderToolMessage(
  message: unknown,
  options: Partial<RenderMessageGroupOptions> = {},
) {
  renderAssistantMessage(message, options);
  await settleToolBridges(view);
}

async function renderToolGroups(
  groups: MessageGroup[],
  options: Partial<RenderMessageGroupOptions>,
) {
  renderMessageGroups(groups, options);
  await settleToolBridges(view);
}

function toolFixture(message: unknown, grouped = false) {
  document.body.append(view);
  const groups = grouped ? [createMessageGroup(message, "tool")] : [];
  return (expanded: boolean, options: Partial<RenderMessageGroupOptions> = {}) =>
    grouped
      ? renderToolGroups(groups, { isToolMessageExpanded: () => expanded, ...options })
      : renderToolMessage(message, { isToolExpanded: () => expanded, ...options });
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
  const rerender = () =>
    renderAssistantMessage(message(), { ...options, mediaOwner: rerender }, container);
  rerender();
}

function renderAssistantMessages(
  messages: unknown[],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const group = createMessageGroup(messages[0], "assistant", {
    key: "assistant-group",
    messages: messages.map((message, index) => ({ key: `assistant-message-${index}`, message })),
  });
  render(renderTestMessageGroup(group, opts));
}

function renderAssistantMessageEntries(
  entries: TestMessageEntry[],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  const group = createMessageGroup(entries[0]?.message, "assistant", {
    key: "assistant-group",
    messages: entries,
    timestamp: Date.now(),
  });
  render(renderTestMessageGroup(group, opts));
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

it.each([
  [
    "bounded structured status",
    ["one", "two", "three", "four", "five", "six"].map((name) => `src/${name}.ts`),
    "claim-456",
    7,
  ],
  ["escaped terminal-control filenames", ["src/line\nbreak.ts"], "claim-control", undefined],
] as const)("renders %s in durable history", (_label, paths, ref, totalCount) => {
  const stagedResultRef = `refs/openclaw/worker-results/${ref}`;
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
    expectPresent(".chat-group.workspace-conflict");
    const card = requireElement(".chat-workspace-conflict-event", HTMLDivElement);
    expect(card.textContent).toContain("Cloud result applied with 7 conflicts");
    expect(card.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(card.textContent).toContain("+2 more paths");
    expect(card.textContent).toContain(stagedResultRef);
    expect(card.querySelector(".chat-text")).toBeNull();
    expect(elementText(".chat-sender-name")).toBe("Cloud workspace");
  }
});

function renderMessageGroups(
  groups: MessageGroup[],
  opts: Partial<RenderMessageGroupOptions> = {},
) {
  render(groups.map((group) => renderTestMessageGroup(group, opts)));
}

async function flushAttachmentChecks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

async function advanceAttachments(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushAttachmentChecks();
}

function mediaTicketPayload(mediaTicket: string, ttlMs = 5 * 60 * 1000) {
  return {
    available: true,
    mediaTicket,
    mediaTicketExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

function stubFetch<T extends NonNullable<Parameters<typeof vi.fn>[0]>>(implementation?: T) {
  const mock = vi.fn(implementation);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function buildItems(overrides: Partial<Parameters<typeof buildCachedChatItems>[0]>) {
  return buildCachedChatItems({
    paneId: "test",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  });
}

function toolResultEntry(key: string, ...args: Parameters<typeof createToolResultMessage>) {
  return createMessageEntry(key, createToolResultMessage(...args));
}

function toolResultGroup(...args: Parameters<typeof createToolResultMessage>) {
  return createMessageGroup(createToolResultMessage(...args), "tool");
}

function nativeAudio(
  source: string,
  artifactId: string,
  overrides: TestMessage = {},
  message: TestMessage = {},
) {
  return createAssistantAudioMessage(
    source,
    {
      artifactId,
      fileName: "voice.mp3",
      mimeType: "audio/mpeg",
      playback: "native",
      ...overrides,
    },
    message,
  );
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
    () => nativeAudio(source, artifactId),
    { showToolCalls: false, resolveArtifactDownload },
    container,
  );
  return container;
}

function mountAssistantImage(url: string, alt: string) {
  const container = document.createElement("div");
  renderAssistantMessage(createAssistantImageMessage(url, alt), {}, container);
  return container;
}

function renderImageBatch(urls: string[], label: string) {
  renderAssistantMessage(
    createAssistantMessage(
      urls.map((url, index) => createMediaBlock({ url, alt: `${label} ${index + 1}` })),
    ),
  );
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
  const items = buildItems({
    paneId,
    runId,
    guardianNotices: host.guardianNotices,
  });
  if (!items.length || !items.every((item) => item.kind === "notice")) {
    throw new Error("Expected notice projections");
  }
  render(items.map((item) => renderChatNotice(item)));
}

afterEach(() => {
  for (const mount of messageMounts.values()) {
    mount.dispose();
  }
  messageMounts.clear();
  view.remove();
  // These detached render fixtures own the callbacks a live chat pane normally releases.
  for (const subscriber of mediaSubscribers) {
    releaseChatMediaResourceOwner(subscriber);
  }
  mediaSubscribers.clear();
  markdownRenderMock.mockClear();
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

  it("preserves reference links and one duplicate badge in recovered media", async () => {
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
    await waitForSolid(() =>
      expect(
        elements(".chat-text a, .chat-message-image").map((node) =>
          node instanceof HTMLImageElement ? "image" : node.textContent,
        ),
      ).toEqual(["Before", "image", "After"]),
    );
    expect(elements<HTMLAnchorElement>(".chat-text a").map((link) => link.href)).toEqual([
      "https://example.com/proof",
      "https://example.com/proof",
    ]);
    expectCount(".chat-duplicate-count", 1);
    expect(view.textContent).not.toContain("Loading preview");
  });

  it("keeps list structure and its duplicate suffix across an assistant image", async () => {
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
    const list = requireElement(".chat-text ol", HTMLOListElement);
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    await waitForSolid(() =>
      expect(list.querySelector("li:first-child .chat-message-image")).not.toBeNull(),
    );
    expect(list.querySelector("li:last-child")?.textContent).toBe("Second\u00a0×2");
    expect(list.querySelector("li:last-child > .chat-duplicate-count")?.textContent).toBe("×2");
  });

  it("suppresses a whole thinking region spanning assistant media", () => {
    renderMarkdownAssistant([
      { type: "text", text: "<thinking>Hidden before" },
      { type: "image", url: "https://example.com/hidden-before.png" },
      { type: "text", text: "Hidden middle" },
      { type: "image", url: "https://example.com/hidden-after.png" },
      { type: "text", text: "Hidden after</thinking>\n\nVisible answer" },
    ]);
    expect(elementText(".chat-text")?.trim()).toBe("Visible answer");
  });

  it("keeps literal media-marker text distinct from assistant image positions", async () => {
    renderMarkdownAssistant(
      "Literal OPENCLAWMEDIASLOT0END\n\nMEDIA:https://example.com/real.png\n\nDone",
    );
    expect(view.textContent).toContain("Literal OPENCLAWMEDIASLOT0END");
    expect(view.textContent).not.toContain("OPENCLAWMEDIASLOTX");
    await waitForSolid(() => expectCount(".chat-message-image", 1));
  });

  it("keeps an inline image mounted while the following paragraph streams and completes", async () => {
    const renderTurn = (tail: string, isStreaming: boolean) => {
      const message = createAssistantMessage(
        `**Before**\nMEDIA:https://example.com/stream.png\n\n${tail}`,
        { timestamp: 1000 },
      );
      render(
        renderTestMessageGroup(
          createMessageGroup(message, "assistant", { key: "stream-media", isStreaming }),
        ),
      );
    };
    await markdownRenderMock.withImplementation(renderMarkdownHtml, async () => {
      await streamingMarkdownRenderMock.withImplementation(renderStreamingMarkdown, async () => {
        renderTurn("Checking", true);
        const image = await waitForSolid(() =>
          requireElement(".chat-message-image", HTMLImageElement),
        );
        expect(requireElement(".chat-bubble", HTMLElement).classList.contains("fade-in")).toBe(
          false,
        );
        expect(requireElement(".chat-group", HTMLElement).dataset.chatRowKey).toBeTruthy();
        renderTurn("Checking the result.", true);
        expect(element(".chat-message-image")).toBe(image);
        renderTurn("Checking the result.", false);
        expect(element(".chat-message-image")).toBe(image);
        expect(elementText(".chat-text")).toContain("Checking the result.");
      });
    });
  });

  it("uses the visible caption direction when an assistant image comes first", () => {
    renderMarkdownAssistant(
      "MEDIA:https://example.com/preview.png\n\n<thinking>Hidden English</thinking>שלום",
    );
    expect(element(".chat-text")?.getAttribute("dir")).toBe("rtl");
    expect(elementText(".chat-text")?.trim()).toBe("שלום");
  });

  it.each([
    ["compact details", "<details><summary>More</summary>body</details>", "details"],
    ["table", "| Name | Value |\n| --- | --- |\n| one | two |", ".markdown-table"],
  ])("keeps a duplicate marker outside terminal %s content", (_label, markdownText, terminal) => {
    markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
    renderAssistantMessageEntries([
      {
        key: "assistant-duplicate",
        message: createAssistantMessage(markdownText, { timestamp: 1 }),
        duplicateCount: 3,
      },
    ]);

    const chatText = requireElement(".chat-text", HTMLDivElement);
    const terminalBlock = requireElement(terminal, HTMLElement, chatText);
    expect(terminalBlock.querySelector(".chat-duplicate-count")).toBeNull();
    expect(chatText.querySelector(":scope > .chat-duplicate-count")?.textContent).toBe("×3");
    expect(chatText.querySelector("summary")?.textContent ?? "").not.toContain("×3");
    expect(chatText.querySelector("td:last-child")?.textContent ?? "").not.toContain("×3");
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

      const status = element(".chat-send-status");
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
      const disclosure = requireElement(".chat-message-disclosure", HTMLDivElement);
      const toggle = requireElement(
        ".chat-message-disclosure__toggle",
        HTMLButtonElement,
        disclosure,
      );
      const text = requireElement(".chat-text", HTMLDivElement, disclosure);
      const fileLink = requireElement("a.markdown-file-link", HTMLAnchorElement, text);
      expect(
        requireElement(".chat-bubble", HTMLDivElement).classList.contains(
          "chat-bubble--with-images",
        ),
      ).toBe(true);
      expectPresent(".chat-message-image");
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
    expect(elements(".msg-meta__tokens").map((node) => node.textContent)).toEqual([
      "↑100k",
      "↓901.2k",
    ]);
    expect(elements(".msg-meta__cache").map((node) => node.textContent)).toEqual([
      "R438.4k",
      "W307",
    ]);
    expect(elementText(".msg-meta__cost")).toContain("$0.12");
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
    expect(renderTimestamp(now + 30_000)).toBe("Just now");
    expect(renderTimestamp(now - 10_000)).toBe("Just now");

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
    renderStreamGroup(
      [
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
      ],
      {},
      container,
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
    expect(elementText(".chat-reply-attribution__name", container)).toBe("Alice Chen");
    expect(container.querySelectorAll(".chat-reply-connector")).toHaveLength(1);
    expect(container.querySelector(".chat-group--reply")).not.toBeNull();
  });

  it("morphs one assistant turn from working status to its terminal recap", () => {
    const message = createAssistantMessage("First result is ready.", { timestamp: 1_000 });

    renderAssistantMessage(message, {
      activeContinuation: {
        parts: [{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }],
        options: {},
      },
    });

    expectCount(".chat-group.assistant", 1);
    expectAbsent(".chat-reading-indicator");
    expectPresent(".chat-working-indicator--continuation");
    expect(elementText(".chat-working-indicator__status")).toContain("Working…");
    // The footer row is reserved but empty until the turn settles.
    expect(element(".chat-group-footer")?.childElementCount).toBe(0);

    renderAssistantMessage(message, {
      turnRecap: { runtimeMs: 4 * 3_600_000 + 2 * 60_000, outputTokens: 1 },
    });

    expectCount(".chat-group.assistant", 1);
    expectAbsent(".chat-working-indicator");
    // Usage leads and the duration follows, matching the live indicator's order.
    expect(
      Array.from(element(".chat-turn-recap--continuation")!.children, (child) =>
        child.textContent?.trim(),
      ),
    ).toEqual(["1 output token", "·", "Done in 4 hours, 2 minutes"]);
    expectAbsent(".chat-turn-recap__claw");
    expectPresent(".chat-group-footer");
  });

  it("shows live output tokens before the elapsed time", () => {
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      runOutputTokens: 892,
    });

    const status = element(".chat-working-indicator__status");
    const tokens = status?.querySelector(".chat-working-indicator__tokens");
    const elapsed = status?.querySelector(".chat-working-indicator__elapsed");
    expect(tokens?.textContent).toBe("892 output tokens");
    expect(elapsed).not.toBeNull();
    expect(
      tokens!.compareDocumentPosition(elapsed!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(status?.querySelector("openclaw-working-phrase")).toBeNull();
  });

  it("relabels the working indicator while the run waits for approval", () => {
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      startupLabel: "Waiting for a response",
      waitingApproval: true,
      runOutputTokens: 5_500,
    });

    expect(elementText(".chat-working-indicator__status")).toContain("Waiting for approval…");
    expectAbsent(".chat-working-indicator__elapsed");
    expect(elementText(".chat-working-indicator__tokens")).toBe("5.5k output tokens");
  });

  it("keeps streamed assistant content in the guttered group without an avatar", () => {
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
    );

    const group = element(".chat-group.assistant");
    expect(group?.classList.contains("chat-group--working")).toBe(false);
    expect(group?.classList.contains("chat-group--with-footer")).toBe(true);
    expectCount(".chat-avatar.assistant", 0);
    expect(element(".chat-group-footer")?.childElementCount).toBe(0);
    expectCount(".chat-working-indicator", 1);
    expectCount(".chat-reading-indicator", 1);
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
    );
    expectAbsent(".chat-bubble.streaming");
    expect(view.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(10).toISOString(),
    );
  });

  it.each([
    [
      "qualified local profile",
      {
        senderId: "profile-buns",
        senderIdentity: { type: "profile", id: "profile-buns" },
      },
      { userId: "profile-buns", userName: "Buns" },
      "Buns",
      undefined,
      "DIV",
    ],
    [
      "authenticated human with CLI provenance",
      {
        senderId: "profile-1",
        senderName: "Recorded Name",
        senderIdentity: { type: "profile", id: "profile-1" },
        transport: { clients: [{ id: "cli", mode: "cli", displayName: "Task helper" }] },
      },
      { userId: "profile-1", userName: "Current Name" },
      "Current Name",
      "via CLI (Task helper)",
      undefined,
    ],
    [
      "source-only Web and external clients",
      {
        transport: {
          clients: [
            { id: "openclaw-control-ui", mode: "webchat" },
            { id: "cli", mode: "cli", displayName: "Release helper" },
            { id: "gateway-client", mode: "backend", displayName: "Build helper" },
          ],
        },
      },
      {
        avatarPlacement: "gutter",
        userName: "Unrelated Viewer",
        userAvatar: "https://example.test/viewer.png",
      },
      undefined,
      "via CLI (Release helper), RPC (Build helper)",
      null,
    ],
  ] as const)(
    "keeps sender attribution distinct for %s",
    (_label, metadata, options, sender, source, avatar) => {
      const message = createUserMessage("Follow up on the current task.", {
        timestamp: 1000,
        __openclaw: metadata,
      });
      const group = prepareMessageGroup(createMessageEntry("source-message", message));
      render(renderTestMessageGroup(group, options));
      if (sender === undefined) {
        expectAbsent(".chat-sender-name");
        expect(view.textContent).not.toContain("Unrelated Viewer");
      } else {
        expect(elementText(".chat-group.user .chat-sender-name")).toBe(sender);
      }
      if (avatar === null) {
        expectAbsent(".chat-avatar, .chat-author-avatar");
      } else if (avatar !== undefined) {
        expect(element(".chat-avatar.user")?.tagName).toBe(avatar);
      }
      expect(elementText(".chat-message-source")).toBe(source);
    },
  );

  it("sender provenance links only profiles and does not identify colliding legacy senders as you", () => {
    const navigate = vi.fn();
    const renderSender = (senderId: string, profile = true) => {
      const message = createUserMessage("hello", { timestamp: 1000 });
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
    );

    const notice = element(".chat-notice");
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

    const notices = elements(".chat-notice");
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
    const message = createUserMessage("hello", { timestamp: 1000 });
    const group = createMessageGroup(message, "user", {
      key: "gravatar-user",
      senderLabel: "alice",
      // A gateway avatar exercises the image tier without third-party requests.
      sender: { id: "alice@example.com", profileAvatarUrl: "/api/users/alice/avatar" },
    });
    render(renderTestMessageGroup(group, { avatarPlacement: "footer" }));

    const image = await vi.waitFor(() => {
      const result = view.querySelector<HTMLImageElement>(".chat-author-avatar__image");
      expect(result).not.toBeNull();
      expect(result?.getAttribute("src")).toBe("/api/users/alice/avatar");
      return result!;
    });
    image.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(image.parentElement?.classList).toContain("is-fallback"));
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
    const items = buildItems({
      paneId: "counting",
      runId: "run-count",
      messages,
      toolMessages,
      streamSegments: [{ text: "Resuming the cell", ts: 8, itemId: "between", runId: "run-count" }],
    });
    const groups = items.filter((item) => item.kind === "group");
    expect(items.filter((item) => item.kind === "stream")).toHaveLength(1);
    renderActivityGroup(groups, { showReasoning: false, isToolMessageExpanded: () => true });
    await settleToolBridges(view);
    expect(elementText(".chat-activity-group__label")?.trim()).toBe(
      "1 command · 1 other operation",
    );
    expectCount(".chat-tool-row", 2);
  });

  it("renders a persisted call with an unknown outcome until its matching result arrives", async () => {
    document.body.append(view);
    const call = createAssistantMessage(
      [createToolCall("orphan", "exec", { command: "check-workspace" })],
      { __openclaw: { id: "orphan-call", runId: "historic-run" } },
    );
    const renderHistory = async (messages: TestMessage[]) => {
      const history = attachHistoryActivity(prepareChatHistoryFixture(messages));
      const items = buildItems({
        paneId: "unknown-historic-outcome",
        messages: history.messages,
      });
      renderActivityGroup(
        items.filter((item) => item.kind === "group"),
        {
          showReasoning: false,
          runActive: false,
          isToolMessageExpanded: () => true,
          isToolExpanded: () => true,
        },
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
    expectAbsent(".chat-tool-row--running");
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
    expectCount(".chat-tool-row", 1);
    expectAbsent(".chat-tool-row--running");
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

    await renderToolGroups([group], {
      isToolMessageExpanded: (id) => (id === "activity:reviewed-tool-group" ? false : undefined),
    });
    expect(element('.chat-activity-group__review-status[data-outcome="approved"]')).not.toBeNull();
    expect(view.textContent).not.toContain("Guardian approved");

    await renderToolGroups([group], {
      isToolMessageExpanded: () => true,
      isToolExpanded: () => true,
    });
    const review = element('.chat-tool-review[data-review-status="approved"]');
    expect(review?.textContent).toContain("Guardian approved");
    expect(review?.textContent).toContain("Narrowly scoped to the requested file.");
    expectPresent(".chat-tool-msg-body");
    expectCount(".chat-tool-review", 1);
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

    renderActivityGroup(groups.slice(0, 2), opts);
    const initialSummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    const initialBodyId = initialSummary.getAttribute("aria-controls");
    expect(initialSummary.getAttribute("aria-expanded")).toBe("true");
    expect(initialBodyId).toMatch(/^activity-body-[0-9a-f]+$/);
    expect(element(`[id="${initialBodyId}"]`)).not.toBeNull();

    renderActivityGroup(groups, opts);
    const appendedSummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    expect(appendedSummary.getAttribute("aria-controls")).toBe(initialBodyId);
    expect(appendedSummary.getAttribute("aria-expanded")).toBe("true");
    expectCount(".chat-activity-group__body > .chat-bubble", 3);
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

    await renderToolGroups([group], { onToggleToolMessageExpanded });
    expect(elementText(".chat-activity-group__label")).toBe("Raw details");
    expect(elementText(".chat-activity-group__summary")).not.toContain("1 failed");

    await renderToolGroups(prepareHistoryGroups([group]), {
      onToggleToolMessageExpanded,
    });

    expectAbsent(".chat-activity-group.is-open");
    const activitySummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(activitySummary.getAttribute("aria-label")).toBeNull();
    expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
    expect(activitySummary.textContent).toContain("1 failed");
    expect(view.textContent).not.toContain("Read failed");
    expect(activitySummary.querySelector(".chat-activity-group__badge")).toBeNull();
    expectAbsent(".chat-tool-msg-body");
    activitySummary.click();

    expect(onToggleToolMessageExpanded).toHaveBeenCalledWith("activity:tool-group", false);
    view.remove();
  });

  it("keeps inline tool cards collapsed by default and renders expanded state", async () => {
    const show = toolFixture(
      createAssistantMessage(
        [
          createToolCall("call-1", "browser.open", { url: "https://example.com" }),
          createToolResultBlock("call-1", "browser.open", "Opened page", {
            type: "toolresult",
          }),
        ],
        { id: "assistant-1", toolCallId: "call-1" },
      ),
    );
    await show(false);

    expectAbsent(".chat-tool-msg-body");

    await show(true);

    // Simple object args render as key-value rows; only the output keeps a block.
    const kvRow = element(".chat-tool-kv__row");
    expect(kvRow?.querySelector(".chat-tool-kv__key")?.textContent).toBe("url:");
    expect(kvRow?.querySelector(".chat-tool-kv__value")?.textContent).toBe("https://example.com");
    const blocks = elements(".chat-tool-card__block");
    // Plain output is the block's default content, so it carries no header.
    expect(blocks[0]?.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("keeps top-level tool-name results collapsed", async () => {
    document.body.append(view);
    markdownRenderMock.mockClear();
    await renderToolMessage(
      createAssistantMessage("A long tool result that should stay behind the disclosure.", {
        toolName: "bash",
      }),
      { isToolMessageExpanded: () => false },
    );
    requireElement(".chat-bubble--tool-shell", HTMLElement);
    requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expectAbsent(".chat-tool-msg-body");
    expectAbsent(".chat-text");
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

    await renderToolMessage(message, {
      isToolMessageExpanded: () => false,
    });

    const summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.textContent?.trim()).toBe("Heartbeat Respond");
    expect(summary.querySelector("[role=img]")?.ariaLabel).toBe("heartbeat_respond");
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("cleans collapsed tool connector copy while preserving expanded raw input", async () => {
    const show = toolFixture(
      createAssistantMessage(
        [createToolCall("call-string-tool", "presentation_create", "with Example Deck")],
        { id: "assistant-string-tool", toolCallId: "call-string-tool" },
      ),
    );
    await show(false);

    // The cleaned string-arg preview is now the primary collapsed label.
    expect(elementText(".chat-tool-msg-summary__label")?.trim()).toBe("Example Deck");
    expectAbsent(".chat-tool-msg-summary__names");
    expect(elementText(".chat-tool-msg-summary")).not.toContain("with Example Deck");

    await show(true);

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
    await renderToolGroups(
      [createMessageGroup(call, "assistant"), createMessageGroup(result, "tool")],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
      },
    );

    // The call's simple args render as key-value rows; the error keeps a block.
    const kvRows = elements(".chat-tool-kv__row");
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
    const blocks = elements(".chat-tool-card__block");
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
    const onToggleToolMessageExpanded = vi.fn();
    const show = toolFixture(
      createToolResultMessage(
        "call-status-error",
        "sessions_spawn",
        JSON.stringify({ status: "error" }, null, 2),
        { id: "tool-status-error" },
      ),
      true,
    );

    await show(false, { onToggleToolMessageExpanded });

    let summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "sessions_spawn",
    );
    summary.click();
    expect(onToggleToolMessageExpanded).toHaveBeenCalledOnce();

    await show(true);

    summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    // The failure stays recorded: the expanded body closes with the outcome.
    expect(elementText(".chat-tool-card__outcome")).toBe("failed");
    expect(elementText(".chat-tool-msg-body .chat-text pre code")).toBe(
      '{\n  "status": "error"\n}',
    );
    expectAbsent(".chat-tool-msg-body details, .code-block-json-mode");
    view.remove();
  });

  it("renders an expanded orphan tool result without a nested disclosure", async () => {
    document.body.append(view);
    await renderToolGroups(
      [
        toolResultGroup("call-orphan", "read", "Orphan tool output", {
          id: "orphan-tool-result",
        }),
      ],
      { isToolMessageExpanded: () => true },
    );

    expectAbsent(".chat-tool-msg-body .chat-tool-msg-summary");
    expectCount(".chat-tool-card__block code", 1);
    expect(elementText(".chat-tool-card__block code")).toBe("Orphan tool output");
  });

  it("keeps text visible beside an orphan tool-result image", async () => {
    document.body.append(view);
    await renderToolGroups(
      [
        toolResultGroup("call-image", "image", [
          { type: "text", text: "Generated image" },
          { type: "image", data: "cG5n", mimeType: "image/png", alt: "Generated preview" },
        ]),
      ],
      { isToolMessageExpanded: () => true },
    );

    expect(elementText(".chat-text")).toContain("Generated image");
    expect(view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,cG5n",
    );
    expectPresent(".chat-tool-msg-body .chat-tool-msg-summary");
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
    await waitForSolid(() =>
      expect(requireElement(".chat-message-image", HTMLImageElement, container).src).toBe(
        "https://example.com/photo.png",
      ),
    );
    requireElement(".chat-message-image-button", HTMLButtonElement, container).click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "https://example.com/photo.png",
        title: "photo.png",
      }),
    );
    const audioPlayer = requireElement(
      "openclaw-chat-audio-player",
      HTMLElement,
      container,
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
    const button = requireElement(".chat-reply-attribution__target", HTMLButtonElement);
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
    const source = managedSource();
    const ticketedUrl = `${source}?mediaTicket=managed-ticket`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const fetchMock = stubFetch();
    const container = document.body.appendChild(document.createElement("div"));
    renderReactiveAssistant(
      () =>
        nativeAudio(
          source,
          artifactId,
          {
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

    await flushAttachmentChecks();
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

  function managedTicketFixture() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const source = managedSource();
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    return {
      source,
      artifactId,
      ticket: (name: string, ttl: number) => ({
        url: `${source}?mediaTicket=${name}`,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      }),
    };
  }

  function expectManagedAudio(container: Element, blocked: boolean) {
    expect(container.querySelector(".chat-assistant-attachment-card--blocked") !== null).toBe(
      blocked,
    );
  }

  it("backs off stale managed ticket refreshes and eventually marks them unavailable", async () => {
    const { source, artifactId, ticket } = managedTicketFixture();
    let finishSecondRequest: (() => void) | undefined;
    const resolveArtifactDownload = vi.fn(() => {
      const requestNumber = resolveArtifactDownload.mock.calls.length;
      const result = ticket(`stale-${requestNumber}`, requestNumber === 1 ? 6_000 : -1_000);
      if (requestNumber !== 2) {
        return Promise.resolve(result);
      }
      return new Promise<typeof result>((resolve) => {
        finishSecondRequest = () => resolve(result);
      });
    });
    const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
    await flushAttachmentChecks();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    await advanceAttachments(1);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expectManagedAudio(container, true);
    finishSecondRequest?.();
    await flushAttachmentChecks();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    await advanceAttachments(1);

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expectManagedAudio(container, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["unchanged expiry", false, 2, 4_999, 1],
    ["longer-lived recovery after a failed refresh", true, 3, 5_000, 15_000],
  ] as const)(
    "retains a managed ticket through refresh exhaustion with %s",
    async (_label, refreshFails, retainedTicket, beforeExpiry, untilExpiry) => {
      const { source, artifactId, ticket } = managedTicketFixture();
      const initialExpiry = Date.now() + 20_000;
      const resolveArtifactDownload = vi.fn(async () => {
        const attempt = resolveArtifactDownload.mock.calls.length;
        if (refreshFails && attempt === 2) {
          throw new Error("refresh unavailable");
        }
        return ticket(
          `short-${attempt}`,
          refreshFails && attempt === 3 ? 20_000 : initialExpiry - Date.now(),
        );
      });
      const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
      await flushAttachmentChecks();
      await advanceAttachments(5_000);
      if (refreshFails) {
        expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
        expectManagedAudio(container, false);
        expect(attachmentDownload(container)?.getAttribute("href")).toContain(
          "mediaTicket=short-1",
        );
      }
      await advanceAttachments(10_000);
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expect(attachmentDownload(container)?.getAttribute("href")).toContain(
        `mediaTicket=short-${retainedTicket}`,
      );
      expectManagedAudio(container, false);
      await advanceAttachments(beforeExpiry);
      expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
      await advanceAttachments(untilExpiry);
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expectManagedAudio(container, true);
    },
  );

  it("does not render an unticketed managed attachment without an artifact resolver", () => {
    const source = managedSource();
    renderAssistantMessage(nativeAudio(source, `artifact_managed_media_${crypto.randomUUID()}`), {
      showToolCalls: false,
    });

    expectAbsent("openclaw-chat-audio-player");
    expect(elementText(".chat-assistant-attachment-card--blocked")).toContain("Unavailable");
  });

  it("keeps server-rejected outside-allowed-folders media blocked", async () => {
    const code = "outside-allowed-folders";
    const reason = "Outside allowed folders";
    const source = "/home/node/private/bootstrap-secret.mp3";
    const fetchMock = stubFetch(async (url: string, init?: RequestInit) => {
      expect(url).toContain("meta=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      return { ok: true, json: async () => ({ available: false, code, reason }) };
    });

    renderReactiveAssistant(
      () => createAssistantMessage(`Unavailable recording\nMEDIA:${source}`),
      {
        showToolCalls: false,
        resourceBasePath: "/openclaw",
        assistantAttachmentAuthToken: "session-token",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushAttachmentChecks();

    await vi.waitFor(() => {
      expect(
        elementText(
          ".chat-assistant-attachment-card--blocked .chat-assistant-attachment-card__status-meta",
        ),
      ).toContain(reason);
    });
    expectAbsent("audio");
    expect(attachmentDownload(view)).toBeNull();
  });

  it("keeps omitted media visible beside a standalone tool result", async () => {
    document.body.append(view);
    await renderToolMessage(
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
    expectPresent(".chat-tool-msg-summary");
    expect(view.textContent).toContain("Omitted from history");
    expect(view.textContent).toContain("2.0 KB");
  });

  it("renders a video attachment inline and expands it in the lightbox", () => {
    const fetchMock = stubFetch();
    const onOpenImage = vi.fn();
    const onOpenSidebar = vi.fn();
    const label = "clip.mp4";
    const mimeType = "video/mp4";
    const source = `https://example.com/${label}`;

    renderAssistantMessage(
      createAssistantMessage([createAttachmentBlock(source, "video", label, mimeType)]),
      { showToolCalls: false, onOpenImage, onOpenSidebar },
    );

    const player = requireElement("openclaw-chat-video-player", HTMLElement) as HTMLElement & {
      label: string;
      mimeType: string;
      onExpand: (src?: string) => void;
      sourceIdentity: string;
      src: string;
    };
    expect(player).toMatchObject({ label, mimeType, sourceIdentity: source, src: source });
    expectAbsent(".chat-assistant-attachment-card--compact");
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
    const fetchMock = stubFetch((_url: string, init?: RequestInit) => {
      const signal = expectDefined(init?.signal, "attachment request signal");
      return rejectWhenAborted<Response>(signal, () =>
        signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"),
      );
    });
    renderReactiveAssistant(() => createAssistantMessage(`Local document\nMEDIA:${source}`), {
      showToolCalls: false,
      resourceBasePath: "/openclaw",
    });

    const card = requireElement(".chat-assistant-attachment-card--compact", HTMLElement);
    const download = requireElement("a[download]", HTMLAnchorElement, card);
    expect(card.textContent).toContain(source.split("/").at(-1));
    expect(card.querySelector(".skeleton")).toBeNull();
    expect([
      download.getAttribute("href"),
      download.getAttribute("aria-disabled"),
      download.tabIndex,
    ]).toEqual([null, "true", 0]);

    const expectedMetaUrl = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&meta=1`;
    await vi.advanceTimersByTimeAsync(0);
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, expectedMetaUrl);
    await advanceAttachments(30_001);

    expect(fetchInit?.signal).toMatchObject({ aborted: true });
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(elementText(".chat-assistant-attachment-card__status-meta")).toContain("Unavailable");
    expectAbsent(".chat-assistant-attachment-card__action-skeleton");
  });

  it("renders transcript image variants with their message identity and structured image blocks", async () => {
    const firstSource = `/tmp/openclaw/${crypto.randomUUID()}-first.png`;
    const secondSource = `/tmp/openclaw/${crypto.randomUUID()}-second.jpg`;
    const fetchMock = stubFetch(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-transcript") };
    });

    const renderUserMedia = (id: string, media: { path: string; contentType: string }[]) => {
      const rerender = () =>
        renderGroupedMessage(createUserMessage("", { __openclaw: { id, media } }), "user", {
          showToolCalls: false,
          sessionKey: "agent:main:transcript-images",
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          mediaOwner: rerender,
        });
      rerender();
    };

    renderUserMedia("saved-image-octet-stream", [
      { path: firstSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(
        view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
      ).toContain(`source=${encodeURIComponent(firstSource)}`),
    );
    const firstImageUrl = new URL(view.querySelector<HTMLImageElement>(".chat-message-image")!.src);
    expect([
      firstImageUrl.searchParams.get("messageId"),
      firstImageUrl.searchParams.get("sessionKey"),
    ]).toEqual(["saved-image-octet-stream", "agent:main:transcript-images"]);

    renderUserMedia("saved-image-pair", [
      { path: firstSource, contentType: "image/png" },
      { path: secondSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(
        elements<HTMLImageElement>(".chat-message-image").map((image) => image.getAttribute("src")),
      ).toEqual([
        expect.stringContaining(`source=${encodeURIComponent(firstSource)}`),
        expect.stringContaining(`source=${encodeURIComponent(secondSource)}`),
      ]),
    );
    expect(
      elements<HTMLImageElement>(".chat-message-image").map((image) =>
        new URL(image.src).searchParams.get("messageId"),
      ),
    ).toEqual(["saved-image-pair", "saved-image-pair"]);
    expect(
      fetchMock.mock.calls.map(([url]) => {
        const params = new URL(url, "http://control.test").searchParams;
        return [params.get("source"), params.get("messageId")];
      }),
    ).toEqual([
      [firstSource, "saved-image-octet-stream"],
      [firstSource, "saved-image-pair"],
      [secondSource, "saved-image-pair"],
    ]);

    renderAssistantMessage(
      createAssistantMessage([{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]),
    );
    expect(view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,cG5n",
    );
  });

  it("expires pairing QR images without requesting a pane refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:45:00Z"));

    const renderQr = (data: string, ttl: number) =>
      renderAssistantMessage(
        createAssistantMessage([
          {
            type: "openclaw_pairing_qr",
            image_url: `data:image/png;base64,${data}`,
            alt: "OpenClaw pairing QR code",
            expiresAtMs: Date.now() + ttl,
          },
        ]),
        { showToolCalls: false },
      );
    renderQr("cXJwbmc=", 1_000);

    const image = view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toMatchObject({
      src: "data:image/png;base64,cXJwbmc=",
      alt: "OpenClaw pairing QR code",
    });
    const bubble = element(".chat-bubble");
    expect(bubble).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(element(".chat-message-image")).toBe(image);
    await vi.advanceTimersByTimeAsync(1);
    expect(element(".chat-bubble")).toBe(bubble);
    expectAbsent(".chat-message-image");
    expect(view.textContent).toContain("Pairing QR expired");

    renderQr("ZXhwaXJlZA==", -1);
    expectAbsent(".chat-message-image");
    expect(view.textContent).toContain("Pairing QR expired");
  });

  it.each([
    "media://inbound/nested%2Fphoto.png",
    "media://inbound/%00.png",
    "media://inbound/nested/../photo.png",
    "media://inbound/..",
  ])("does not proxy non-canonical inbound media ref %s", (source) => {
    const fetchMock = stubFetch();

    renderGroupedMessage(
      createUserMessage("", {
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
    const managedChatImageUrl = managedSource();
    const objectUrl = "blob:managed-image";
    stubObjectUrls(() => objectUrl);
    const fetchMock = stubFetch(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-auth-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });

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
      expect(element(".chat-message-image")).toMatchObject({
        src: objectUrl,
        alt: "Generated image 1",
      });
    });
    const thumbnailUrl = `/rosita${managedChatImageUrl.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, thumbnailUrl);
    expectSameOriginGet(fetchInit);
    requireElement(".chat-message-image-button", HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(onOpenImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: objectUrl, title: "Generated image 1" }),
      ),
    );
    const activeItem = onOpenImage.mock.calls[0]?.[0];
    activeItem?.release?.();
  });

  it("refreshes a managed attachment ticket while its Files player stays open", async () => {
    const { source, artifactId, ticket } = managedTicketFixture();
    const first = ticket("first", 31_000);
    const refreshed = ticket("refreshed", 5 * 60_000);
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(refreshed);
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

    await flushAttachmentChecks();
    requireElement(".chat-assistant-attachment-card__expand", HTMLButtonElement, container).click();
    expect(sidebarContent).not.toHaveProperty("src");
    expect(sidebarContent).toHaveProperty("sourceIdentity", source);

    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      attachmentRuntime: unknown;
      updateComplete: Promise<unknown>;
    };
    panel.content = sidebarContent;
    panel.attachmentRuntime = { resolveArtifactDownload };
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(first.url);

    await advanceAttachments(1_000);
    await panel.updateComplete;

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(refreshed.url);
    panel.remove();
    container.remove();
  });

  it("downloads a managed image from its pure-image actions", async () => {
    const artifactId = `artifact_managed_image_${crypto.randomUUID()}`;
    const source = managedSource();
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const thumbnailUrl = `${ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail")}&v=4&width=480`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const objectUrls = ["blob:thumbnail", "blob:full", "blob:download"];
    const { revokeObjectURL } = stubObjectUrls(() => objectUrls.shift() ?? "blob:extra");
    const imageBlob = new Blob(["png"], { type: "image/png" });
    const fetchMock = stubFetch(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      blob: async () => imageBlob,
    }));
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
    requireElement(".chat-image-action", HTMLButtonElement, container).click();
    await waitForSolid(() =>
      expect(
        container.querySelector(".chat-image-actions .oc-menu")!.matches(":popover-open"),
      ).toBe(true),
    );
    // Own the delayed download cleanup before restoring the URL globals.
    vi.useFakeTimers();
    requireElement(
      '.chat-image-actions [data-value="download"]',
      HTMLButtonElement,
      container,
    ).click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(clickedDownloads[0]).toBe("Ticketed image.png");

    expect(fetchMock.mock.calls.filter((call: unknown[]) => call[0] === ticketedUrl)).toHaveLength(
      1,
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:download");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
    container.remove();
  });

  it("falls back when a managed outgoing image body stalls after headers", async () => {
    vi.useFakeTimers();
    const source = managedSource();
    const fetchMock = stubFetch(async (_url: string, init?: RequestInit) => {
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

    renderAssistantMessage(
      createAssistantImageMessage(source, "Generated image body stall", {
        width: 1,
        height: 1,
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      `${source.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`,
    );
    expect(fetchInit?.signal?.aborted).toBe(false);
    expectSameOriginGet(fetchInit);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expectAbsent(".chat-message-image");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds managed outgoing image blob URLs with least-recently-used eviction", async () => {
    const imageUrls = Array.from({ length: 65 }, () => managedSource());
    let objectUrlIndex = 0;
    const { createObjectURL, revokeObjectURL } = stubObjectUrls(
      () => `blob:managed-image-${objectUrlIndex++}`,
    );
    let deferEvictedRefetch = false;
    let resolveEvictedRefetch:
      | ((response: { ok: boolean; blob: () => Promise<Blob> }) => void)
      | undefined;
    const response = { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    stubFetch((url: string) => {
      if (
        deferEvictedRefetch &&
        url === `${imageUrls[1]?.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`
      ) {
        return new Promise<typeof response>((resolve) => {
          resolveEvictedRefetch = resolve;
        });
      }
      return Promise.resolve(response);
    });

    renderImageBatch(imageUrls.slice(0, 64), "Generated image");
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(64));

    mountAssistantImage(imageUrls[0]!, "Recently viewed image");
    expect(createObjectURL).toHaveBeenCalledTimes(64);

    const createsBeforeOverflow = createObjectURL.mock.calls.length;
    mountAssistantImage(imageUrls[64]!, "Newest image");
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeOverflow),
    );
    expect(revokeObjectURL).toHaveBeenCalled();

    deferEvictedRefetch = true;
    const evictedContainer = mountAssistantImage(imageUrls[1]!, "Refetched image");
    await vi.waitFor(() => expect(resolveEvictedRefetch).toBeTypeOf("function"));

    const createsBeforeRefetch = createObjectURL.mock.calls.length;
    resolveEvictedRefetch?.(response);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeRefetch),
    );
    expect(evictedContainer.querySelector(".chat-message-image")).not.toBeNull();
  });

  it("bounds managed outgoing image miss retention", async () => {
    const imageUrls = Array.from({ length: 65 }, () => managedSource());
    const fetchMock = stubFetch(async () => ({ ok: false }));

    renderImageBatch(imageUrls.slice(0, 64), "Missing image");
    await waitForSolid(() => expectCount(".chat-image-frame--compact", 64));
    const overflowContainer = mountAssistantImage(imageUrls[64]!, "Newest missing image");
    await waitForSolid(() =>
      expect(overflowContainer.querySelector(".chat-image-frame--compact")).not.toBeNull(),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length));
    await flushAttachmentChecks();

    mountAssistantImage(imageUrls[0]!, "Oldest missing image");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length + 1));
  });

  it("does not send auth to cross-origin managed-image-looking URLs", async () => {
    const source =
      "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full";
    const fetchMock = stubFetch(async () => {
      throw new Error("cross-origin image URL should not be fetched with Control UI auth");
    });

    renderAssistantMessage(createAssistantImageMessage(source, "Untrusted image"), {
      showToolCalls: false,
      assistantAttachmentAuthToken: "session-token",
    });

    await waitForSolid(() =>
      expect(element(".chat-message-image")?.getAttribute("src")).toBe(source),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["canvas-only shortcode", false, "cv_tictactoe", "Tic-Tac-Toe"],
    ["lifted canvas beside a flat tool row", true, "cv_inline_tool_canvas", "Inline demo"],
  ] as const)(
    "renders a %s inside its assistant bubble",
    async (_label, toolSummary, docId, title) => {
      const context = createInitializationContext();
      const provider = mountSolid(() => <ApplicationProvider value={context} host={view} />, {});
      onTestFinished(provider.dispose);
      document.body.append(view);
      const content = toolSummary
        ? [
            {
              type: "tool_use",
              id: "call-tool-canvas",
              name: "bash",
              input: { command: "render preview" },
            },
            createAssistantCanvasBlock({ suffix: "tool_canvas" }),
          ]
        : [{ type: "text", text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]' }];
      await renderToolMessage(
        createAssistantMessage(content, toolSummary ? { toolName: "bash" } : {}),
        {
          showToolCalls: toolSummary,
          isToolMessageExpanded: () => true,
        },
      );
      const bubble = requireElement(
        toolSummary ? ".chat-bubble--tool-shell" : ".chat-bubble",
        HTMLElement,
      );
      const widget = expectCanvasWidget(view, { docId, title });
      expect(bubble.contains(widget)).toBe(true);
      if (toolSummary) {
        expectPresent(".chat-tool-msg-summary");
      }
    },
  );

  it("opens only safe assistant image URLs in the lightbox", async () => {
    const onOpenImage = vi.fn();
    for (const [url, safe] of [
      ["https://example.com/cat.png", true],
      ["javascript:alert(1)", false],
      ["data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />", false],
    ] as const) {
      onOpenImage.mockClear();
      renderAssistantMessage(createAssistantMessage([{ type: "image_url", image_url: { url } }]), {
        onOpenImage,
      });
      await waitForSolid(() =>
        expect(element(".chat-message-image")).toBeInstanceOf(HTMLImageElement),
      );
      requireElement(".chat-message-image", HTMLImageElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      if (safe) {
        expect(onOpenImage).toHaveBeenCalledWith(
          expect.objectContaining({ src: url, title: "Image" }),
        );
      } else {
        expect(onOpenImage).not.toHaveBeenCalled();
      }
    }
  });

  it("opens generic tool details instead of a canvas preview from tool rows", async () => {
    document.body.append(view);
    const onOpenSidebar = vi.fn();
    const canvas = createAssistantCanvasBlock({
      suffix: "sidebar",
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
    requireElement(".chat-tool-card__action-btn", HTMLButtonElement).click();
    expectAbsent(".chat-tool-card__preview-frame");
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(onOpenSidebar).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool-output" }));
  });

  function renderAssistantDisclosureActionFixture(
    options: Partial<RenderMessageGroupOptions> = {},
    message: TestMessage = {},
    text = "Assistant preview\n...(truncated)...",
  ) {
    renderAssistantMessage(
      createAssistantMessage(text, {
        __openclaw: { id: "assistant-disclosure-actions", seq: 1, truncated: true },
        ...message,
      }),
      {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: "Complete assistant message beyond the transcript preview.",
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
        ...options,
      },
    );
    return { container: view, preview: text };
  }

  it("keeps loaded assistant thinking private while bounding reply context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const onReply = vi.fn();
    const visibleMessage = `${"a".repeat(499)}😀 full loaded answer`;
    renderAssistantDisclosureActionFixture({
      onReply,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>private loaded reasoning</thinking>${visibleMessage}`,
        revision: 1,
      }),
    });

    requireElement(".chat-group-footer-actions .chat-copy-btn", HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(visibleMessage));

    requireElement(
      '.chat-group-footer-actions [aria-label="Reply to message"]',
      HTMLButtonElement,
    ).click();
    expect(onReply).toHaveBeenCalledWith({
      messageId: "assistant-message",
      senderLabel: "OpenClaw",
      sourceMessageId: "assistant-disclosure-actions",
      text: "a".repeat(499),
    });
    expect(element(".chat-bubble")?.dataset.messageText).toBe(visibleMessage);
  });

  it("does not restore a disclosure control for hidden-only loaded assistant text", () => {
    const onReply = vi.fn();
    const onToggleAssistantMessageExpanded = vi.fn();
    const privateThinking = "private expanded reasoning only";
    const { preview } = renderAssistantDisclosureActionFixture({
      onReply,
      onToggleAssistantMessageExpanded,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>${privateThinking}</thinking>`,
        revision: 1,
      }),
    });

    expect(elementText(".chat-text")?.trim()).toBe("");
    expect(view.textContent).not.toContain(privateThinking);
    expect(view.textContent).not.toContain(preview);
    expectAbsent(
      ".chat-group-footer-actions .chat-copy-btn",
      '[aria-label="Reply to message"]',
      ".chat-message-disclosure__toggle",
    );
    expect(element(".chat-bubble")?.hasAttribute("data-message-text")).toBe(false);
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
    expect(elements(".chat-text").map((node) => node.textContent)).toEqual(previews);
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
    renderAssistantDisclosureActionFixture(
      {
        sessionKey: "global",
        getAssistantMessageExpansion: () => undefined,
        onToggleAssistantMessageExpanded,
      },
      { openclawMessageToolMirror: { toolName: "message", toolCallId: "call-1" } },
      "mirrored text\n...(truncated)...",
    );

    expectAbsent(".chat-message-disclosure__toggle");
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it("keeps the oversized notice visible when assistant recovery exhausts", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantDisclosureActionFixture(
      {
        sessionKey: "global",
        getAssistantMessageExpansion: () => ({ status: "error", revision: 6 }),
        onToggleAssistantMessageExpanded,
      },
      { __openclaw: { id: "oversized-assistant-error", truncated: true, reason: "oversized" } },
      "[chat.history omitted: message too large]",
    );

    expect(elementText(".chat-text")).toContain("This message is too large to display here.");
    expect(view.textContent).not.toContain("[chat.history omitted");
    expect(elementText(".chat-message-load-error")).toContain("Could not load the full message.");
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
    requireElement(".chat-message-load-error__retry", HTMLButtonElement).click();
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("oversized-assistant-error");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
