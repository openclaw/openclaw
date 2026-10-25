import { expectDefined } from "@openclaw/normalization-core";
import { For, Show } from "solid-js";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { loadStreamingMarkdown } from "../../../components/markdown-live-loader.ts";
import * as markdownLive from "../../../components/markdown-live.ts";
import * as markdown from "../../../components/markdown.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setAvatarGatewayOrigin } from "../../../lib/identity-avatar-context.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import * as chatAvatar from "../chat-avatar-view.tsx";
import { buildCachedChatItems } from "../chat-thread.ts";
import { ChatNotice } from "./chat-divider.tsx";
import {
  ActivityGroup,
  MessageGroup as MessageGroupView,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { StreamGroup } from "./chat-message-stream-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import "./chat-detail-panel.tsx";

export type RenderMessageGroupOptions = NativeMessageGroupOptions;
type MessageFixture =
  | { kind: "group"; props: Parameters<typeof MessageGroupView>[0] }
  | { kind: "activity"; props: Parameters<typeof ActivityGroup>[0] }
  | { kind: "stream"; props: Parameters<typeof StreamGroup>[0] }
  | { kind: "notice"; props: Parameters<typeof ChatNotice>[0] };

export function createChatMessageHarness() {
  let view: HTMLDivElement;

  const mediaSubscribers = new Set<object>();

  const renderMarkdownHtml = markdown.toSanitizedMarkdownHtml;

  const renderStreamingMarkdown = markdownLive.toStreamingMarkdownDomParts;

  const markdownRenderMock = vi.fn<typeof markdown.toSanitizedMarkdownHtml>((value) => value);

  const streamingMarkdownRenderMock = vi.fn<typeof markdownLive.toStreamingMarkdownDomParts>(
    (value) => ["", `<div class="streaming-markdown">${value}</div>`],
  );

  const messageMounts = new Map<
    HTMLElement,
    ReturnType<typeof mountSolid<{ values: MessageFixture[] }>>
  >();

  beforeEach(async () => {
    await loadStreamingMarkdown();
    view = document.createElement("div");
    vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation(markdownRenderMock);
    vi.spyOn(markdownLive, "toStreamingMarkdownDomParts").mockImplementation(
      streamingMarkdownRenderMock,
    );
    vi.spyOn(chatAvatar, "ChatAvatar").mockImplementation(TestAvatar);
  });

  function TestAvatar(props: { role: string }) {
    return <div class={`chat-avatar ${props.role}`} />;
  }

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

  function renderMessageGroups(
    groups: MessageGroup[],
    opts: Partial<RenderMessageGroupOptions> = {},
  ) {
    render(groups.map((group) => renderTestMessageGroup(group, opts)));
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

  return {
    get view() {
      return view;
    },
    render,
    renderActivityGroup,
    renderStreamGroup,
    renderChatNotice,
    requireElement,
    element,
    elements,
    elementText,
    expectCount,
    expectAbsent,
    expectPresent,
    renderTestMessageGroup,
    renderAssistantMessage,
    renderToolMessage,
    renderToolGroups,
    renderAssistantMessages,
    renderGroupedMessage,
    renderMessageGroups,
    renderMarkdownHtml,
    renderStreamingMarkdown,
    markdownRenderMock,
    streamingMarkdownRenderMock,
  };
}

export function buildItems(overrides: Partial<Parameters<typeof buildCachedChatItems>[0]>) {
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
