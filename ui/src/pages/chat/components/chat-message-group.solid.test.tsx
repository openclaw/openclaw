/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
} from "../../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { ControlUiPluginCapability } from "../../../plugins/control-ui-capability.ts";
import "../../../plugins/control-ui-view.solid.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { buildLocalUserMessage } from "../user-message-content.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { dismissConfirmedActionPopovers } from "./chat-message-confirmation-view.tsx";
import { prepareGroupMessage } from "./chat-message-group-frame.ts";
import {
  ActivityGroup,
  MessageGroup,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { createMessageGroup, createToolResultMessage } from "./chat-message.test-support.ts";

it.each([false, true])(
  "does not present a partial response group as complete usage (unavailable: %s)",
  (unavailable) => {
    const first = {
      role: "assistant",
      content: "First answer.",
      timestamp: 1000,
      usage: { input: 100, output: 20, cost: { total: 1 } },
    };
    const group = createMessageGroup(first, "assistant", {
      messages: [
        { key: "first", message: first },
        {
          key: "second",
          message: {
            ...first,
            content: "Second answer.",
            usage: {
              input: 50,
              output: 50,
              cost: { total: 2 },
              ...(unavailable ? { usageReport: { state: "unavailable" } } : {}),
            },
          },
        },
      ],
    });
    const view = mountSolid(() => (
      <MessageGroup group={group} options={{ showReasoning: false, contextWindow: 1000 }} />
    ));
    flush();
    const metadata = view.container.querySelector(".msg-meta__details");
    expect(
      [...(metadata?.querySelectorAll(".msg-meta__tokens") ?? [])].map((node) => node.textContent),
    ).toEqual(unavailable ? ["Token usage and cost unavailable"] : ["↑150", "↓70"]);
    expect([
      metadata?.querySelector(".msg-meta__cost") === null,
      metadata?.querySelector(".msg-meta__ctx") === null,
    ]).toEqual([unavailable, unavailable]);
  },
);

it.each([
  ["ends with its answer", true],
  ["is still working", false],
])("gives progress before tool calls no reply actions when an unframed group %s", (_, answered) => {
  // Claude, Gemini and other providers mark progress only with a `toolUse` stop, not a phase.
  const progress = (text: string, timestamp: number) => ({
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: `call-${timestamp}`, name: "exec", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp,
  });
  const messages = [
    { key: "progress-1", message: progress("Checking the tests first:", 1000) },
    { key: "progress-2", message: progress("Now applying the fix:", 2000) },
    ...(answered
      ? [
          {
            key: "answer",
            message: {
              role: "assistant",
              content: "The fix is ready.",
              stopReason: "stop",
              timestamp: 3000,
            },
          },
        ]
      : []),
  ];
  const group = createMessageGroup(messages[0]!.message, "assistant", { messages });
  const onReply = vi.fn();
  const view = mountSolid(() => (
    <MessageGroup group={group} options={{ showReasoning: false, onReply }} />
  ));
  flush();
  expect(view.container.querySelectorAll(".chat-message-actions-row")).toHaveLength(0);
  const replies = view.container.querySelectorAll<HTMLButtonElement>(
    '.chat-group-footer-actions button[aria-label="Reply to message"]',
  );
  expect(replies).toHaveLength(answered ? 1 : 0);
  replies[0]?.click();
  expect(onReply.mock.calls.map(([target]) => target.messageId)).toEqual(
    answered ? ["answer"] : [],
  );
});

it("does not give provider speech unframed answer actions", () => {
  const speech = {
    role: "assistant",
    content: "It exited with code zero.",
    stopReason: "stop",
    timestamp: 1000,
    __openclaw: { id: "spoken", voiceTranscript: "provider-owned" },
  };
  const group = createMessageGroup(speech, "assistant");
  const prepared = prepareGroupMessage(group, group.messages[0]!, {
    showReasoning: false,
    onReply: vi.fn(),
  });
  expect(prepared.ownsActions).toBe(false);
  expect(prepared.actions?.replyTarget).toBeUndefined();
  expect(prepared.source.displayMarkdown).toBe(speech.content);
});

it("keeps distinct peer avatars and focused message content across group updates", async () => {
  const imageData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const message = (alt: string) => ({
    role: "user",
    content: [
      { type: "text", text: "A retained paragraph." },
      { type: "image", data: imageData, mimeType: "image/png", alt },
    ],
    timestamp: 1000,
  });
  const group = createMessageGroup(message("Peer image"), "user", {
    key: "peer-group",
    senderLabel: "Peer",
    sender: {
      id: "peer",
      name: "Peer",
      identity: { type: "profile", id: "peer" },
      profileAvatarUrl: "/api/users/peer/avatar?v=1",
    },
    messages: [
      { key: "peer-first", message: message("Peer image") },
      {
        key: "peer-second",
        message: { role: "user", content: "Another message.", timestamp: 1001 },
      },
    ],
  });
  const [currentGroup, setGroup] = createSignal(group);
  const [options, setOptions] = createSignal<NativeMessageGroupOptions>({
    userId: "viewer",
    userName: "Viewer",
    showReasoning: false,
    showToolCalls: false,
  });
  const view = mountSolid(() => <MessageGroup group={currentGroup()} options={options()} />);
  await waitForSolid(() => {
    expect(view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")).toHaveLength(2);
    expect(view.getByRole("button", { name: "Open image Peer image" })).toBeDefined();
    expect(view.container.querySelector(".chat-text p")?.textContent).toBe("A retained paragraph.");
  });
  const bubbles = [...view.container.querySelectorAll(".chat-bubble")];
  expect(bubbles).toHaveLength(2);
  const avatars = [...view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")];
  expect(avatars[0]).not.toBe(avatars[1]);
  avatars.forEach((avatar, index) => {
    expect(avatar.closest(".chat-bubble")).toBe(bubbles[index]);
    expect(avatar.querySelector('[aria-label="Peer"]')).not.toBeNull();
  });
  const control = view.getByRole("button", { name: "Open image Peer image" });
  const image = control.querySelector("img")!;
  const paragraph = view.container.querySelector(".chat-text p");
  image.dispatchEvent(new Event("load"));
  control.focus();
  expect(document.activeElement).toBe(control);

  setGroup({
    ...group,
    senderLabel: "Peer Updated",
    sender: { ...group.sender!, name: "Peer Updated" },
    messages: [
      { ...group.messages[0]!, message: message("Updated peer image") },
      { ...group.messages[1]! },
    ],
  });
  setOptions((previous) => ({ ...previous, userName: "Updated Viewer" }));
  flush();
  await waitForSolid(() => {
    expect(view.getByRole("button", { name: "Open image Updated peer image" })).toBe(control);
    expect(view.container.querySelector(".chat-sender-name")?.textContent).toBe("Peer Updated");
  });
  expect(document.activeElement).toBe(control);
  expect(control.querySelector("img")).toBe(image);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  const updatedBubbles = view.container.querySelectorAll(".chat-bubble");
  bubbles.forEach((bubble, index) => expect(updatedBubbles[index]).toBe(bubble));
  const updatedAvatars = [...view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")];
  expect(updatedAvatars).toHaveLength(2);
  expect(updatedAvatars[0]).not.toBe(updatedAvatars[1]);
  expect(
    updatedAvatars.every((avatar) => avatar.querySelector('[aria-label="Peer Updated"]') !== null),
  ).toBe(true);
});

it("retains aggregate disclosure and legacy card focus when options refresh", async () => {
  const messages = ["one", "two"].map((key, index) => ({
    key,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: `call-${key}`, name: "read", input: { path: `${key}.md` } },
      ],
      timestamp: 1000 + index,
    },
  }));
  const group = createMessageGroup(messages[0]!.message, "tool", {
    key: "activity",
    messages,
  });
  const [options, setOptions] = createSignal<NativeMessageGroupOptions>({
    showReasoning: false,
    showToolCalls: true,
    isToolMessageExpanded: () => true,
  });
  const view = mountSolid(() => (
    <ActivityGroup groups={[group]} options={options()} presentation="standalone" />
  ));
  await waitForSolid(() => {
    expect(
      view.container.querySelectorAll(".chat-tools-inline .chat-tool-msg-collapse"),
    ).toHaveLength(2);
  });
  const summary = view.container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!;
  const card = view.container.querySelector(".chat-tools-inline .chat-tool-msg-collapse");
  const cardControl = card!.querySelector<HTMLButtonElement>("button")!;
  cardControl.focus();
  setOptions((previous) => ({ ...previous, assistantName: "Updated assistant" }));
  flush();
  expect(document.activeElement).toBe(cardControl);
  expect(view.container.querySelector(".chat-tools-inline .chat-tool-msg-collapse")).toBe(card);
  expect(view.container.querySelector(".chat-activity-group__summary")).toBe(summary);
  summary.focus();
  setOptions((previous) => ({ ...previous, userName: "Updated viewer" }));
  flush();
  expect(document.activeElement).toBe(summary);
  expect(view.container.querySelector(".chat-activity-group__summary")).toBe(summary);
});

it("mounts only selected tool replacements and keeps their context, projection, and disposal current", async () => {
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  // SAFETY: This mounted-view fixture supplies the service objects scoped by the host; it never calls their methods.
  const pluginHost = {
    signal: abort.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as ControlUiHost;
  let selected: ControlUiReplacement | undefined;
  const reportError = vi.fn();
  const plugins: ControlUiPluginCapability = {
    errors: [],
    hasPlugins: true,
    registryStatus: "complete",
    canReload: false,
    isLoading: () => false,
    reload: async () => undefined,
    refresh: async () => undefined,
    registrations: () => [],
    loadSettingsView: async () => {
      throw new Error("This chat fixture does not load Settings presentations.");
    },
    selectReplacement: vi.fn(),
    selectedReplacement: (surface) =>
      surface === "tool-result" && selected
        ? {
            key: "fixture/tool",
            pluginId: "fixture",
            value: selected,
            host: pluginHost,
            signal: abort.signal,
          }
        : undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportError,
  };
  // SAFETY: This grouped-renderer fixture consumes only the complete plugin capability.
  const context = { plugins } as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const [group, setGroup] = createSignal(
    createMessageGroup(
      createToolResultMessage("call-read", "read", "Original tool output", { timestamp: 1000 }),
      "tool",
    ),
  );
  const [options, setOptions] = createSignal<NativeMessageGroupOptions>({
    sessionKey: "agent:main:fixture",
    agentId: "main",
    showReasoning: false,
    showToolCalls: true,
    isToolMessageExpanded: () => true,
    presented: true,
  });
  const [active, setActive] = createSignal(true);
  const view = mountSolid(
    () => (
      <ContentPresentation value={active}>
        <MessageGroup group={group()} options={options()} />
      </ContentPresentation>
    ),
    { wrapper: provider.wrapper },
  );
  const nextListeners = new Set<() => void>();
  const nextContext: ApplicationContext = {
    ...context,
    plugins: {
      ...context.plugins,
      subscribe: (listener) => {
        nextListeners.add(listener);
        return () => nextListeners.delete(listener);
      },
    },
  };
  flush();
  try {
    await waitForSolid(() => expect(view.container.textContent).toContain("Original tool output"));
    expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
    let latest: Parameters<ControlUiReplacement["mount"]>[1] | undefined;
    const dispose = vi.fn();
    const replacement: ControlUiReplacement = {
      id: "tool",
      label: "Fixture tool",
      surface: "tool-result",
      mount(container, value) {
        latest = value;
        const title = document.createElement("strong");
        title.textContent = "Selected tool renderer";
        const draft = document.createElement("input");
        draft.setAttribute("aria-label", "Plugin local draft");
        const projection = document.createElement("div");
        container.append(title, draft, projection);
        const unmountDefault = value.mountDefault(projection);
        return {
          update(next) {
            latest = next;
          },
          dispose() {
            unmountDefault();
            dispose();
          },
        };
      },
    };
    selected = replacement;
    for (const listener of listeners) {
      listener();
    }
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Selected tool renderer"),
    );
    expect(view.container.textContent).toContain("Original tool output");
    expect(latest?.props).toMatchObject({
      sessionKey: "agent:main:fixture",
      agentId: "main",
      toolCallId: "call-read",
      toolName: "read",
      expanded: true,
      output: { text: "Original tool output" },
    });
    expect(latest?.presented).toBe(true);
    setGroup(
      createMessageGroup(
        createToolResultMessage("call-read", "read", "Updated tool output", { timestamp: 1000 }),
        "tool",
      ),
    );
    setOptions((previous) => ({ ...previous, presented: false }));
    await waitForSolid(() => {
      expect(latest?.props).toMatchObject({ output: { text: "Updated tool output" } });
      expect(latest?.presented).toBe(false);
      expect(view.container.textContent).toContain("Updated tool output");
    });
    const mountedView = view.container.querySelector("openclaw-plugin-view");
    const localDraft = view.getByLabelText<HTMLInputElement>("Plugin local draft");
    localDraft.value = "Retained plugin draft";
    const mountedSignal = latest?.signal;
    setActive(false);
    flush();
    await Promise.resolve();
    expect(view.container.querySelector("openclaw-plugin-view")).toBe(mountedView);
    expect(mountedSignal?.aborted).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    setActive(true);
    setOptions((previous) => ({ ...previous, presented: true }));
    await waitForSolid(() => {
      expect(latest?.signal).toBe(mountedSignal);
      expect(latest?.presented).toBe(true);
    });
    expect(view.getByLabelText("Plugin local draft")).toBe(localDraft);
    expect(localDraft.value).toBe("Retained plugin draft");
    selected = undefined;
    for (const listener of listeners) {
      listener();
    }
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-plugin-view")).toBeNull(),
    );
    expect(view.container.textContent).toContain("Updated tool output");
    expect(mountedSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
    // Replacing the application owner retires subscriptions from the parked tree.
    selected = replacement;
    for (const listener of listeners) {
      listener();
    }
    setActive(false);
    flush();
    provider.setContext(nextContext);
    setActive(true);
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Selected tool renderer"),
    );
    expect(nextListeners.size).toBeGreaterThan(0);
    expect(listeners.size).toBe(0);
    const reconnectedSignal = latest?.signal;
    view.unmount();
    await Promise.resolve();
    flush();
    expect(reconnectedSignal?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect(nextListeners.size).toBe(0);
  } finally {
    view.unmount();
  }
});

describe("owned message controls", () => {
  beforeEach(() => localStorage.removeItem("openclaw:skip-rewind-confirm"));
  afterEach(() => dismissConfirmedActionPopovers(document.body));

  it("keeps an open work-context disclosure when the same message key receives fresh metadata", () => {
    const message = (title: string) =>
      buildLocalUserMessage({
        text: "Explain this selection",
        createdAt: 1000,
        workContext: { title, page: "chat" },
      });
    const [source, setSource] = createSignal(message("Before"));
    const view = mountSolid(() => (
      <GroupedMessage
        preparation={prepareChatMessageRender(source())}
        messageKey="same-message"
        options={{ isStreaming: false, showReasoning: false }}
      />
    ));
    const disclosure = view.container.querySelector<HTMLDetailsElement>(
      ".chat-context-attachment",
    )!;
    expect(disclosure).not.toBeNull();
    disclosure.open = true;
    setSource(message("After"));
    flush();
    expect(view.container.querySelector(".chat-context-attachment")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain("After");
  });

  it("retains grouped rewind and timestamp controls with current callbacks and metadata", () => {
    const previous = vi.fn();
    const current = vi.fn();
    const prompt = createMessageGroup({ role: "user", content: "Prompt", timestamp: 1000 }, "user");
    const answerAt = (timestamp: number, input: number, output: number) => ({
      role: "assistant",
      content: "Answer",
      timestamp,
      usage: { input, output },
    });
    const answer = createMessageGroup(answerAt(1001, 100, 10), "assistant");
    const [options, setOptions] = createSignal({ onRewind: previous, contextWindow: 4000 });
    const [assistant, setAssistant] = createSignal(answer);
    const view = mountSolid(() => (
      <>
        <MessageGroup group={prompt} options={{ showReasoning: false, ...options() }} />
        <MessageGroup
          group={assistant()}
          options={{ showReasoning: false, contextWindow: options().contextWindow }}
        />
      </>
    ));
    const trigger = view.getByRole("button", { name: "Rewind" });
    trigger.click();
    const confirmation = document.querySelector<HTMLElement>(".chat-confirm-popover")!;
    expect(confirmation).not.toBeNull();
    setOptions({ onRewind: current, contextWindow: 8000 });
    flush();
    expect(view.getByRole("button", { name: "Rewind" })).toBe(trigger);
    expect(document.querySelector(".chat-confirm-popover")).toBe(confirmation);
    confirmation.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();

    const timestamp = view.container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .msg-meta__summary",
    )!;
    expect(timestamp).not.toBeNull();
    timestamp.focus();
    setAssistant({
      ...answer,
      timestamp: 2001,
      messages: [{ ...answer.messages[0]!, message: answerAt(2001, 200, 20) }],
    });
    flush();
    expect(view.container.querySelector(".chat-group.assistant .msg-meta__summary")).toBe(
      timestamp,
    );
    expect(document.activeElement).toBe(timestamp);
  });
});

it("leaves timestamp attributes untouched when only message usage changes", () => {
  const calendarFormat = vi.spyOn(Date.prototype, "toLocaleString");
  const clock = vi.spyOn(Date, "now").mockReturnValue(301_000);
  const answer = createMessageGroup(
    { role: "assistant", content: "Answer", timestamp: 1000, usage: { input: 100, output: 10 } },
    "assistant",
  );
  const [group, setGroup] = createSignal(answer);
  const view = mountSolid(() => (
    <MessageGroup group={group()} options={{ showReasoning: false, contextWindow: 4000 }} />
  ));
  const time = view.container.querySelector<HTMLTimeElement>(".chat-group-timestamp")!;
  const summary = view.container.querySelector<HTMLButtonElement>(".msg-meta__summary")!;
  expect(time.textContent).toBe("5m ago");
  const observer = new MutationObserver(() => {});
  observer.observe(time, { attributes: true });
  observer.observe(summary, { attributes: true });
  calendarFormat.mockClear();
  clock.mockReturnValue(361_000);
  setGroup({
    ...answer,
    messages: [
      {
        ...answer.messages[0]!,
        message: {
          role: "assistant",
          content: "Answer",
          timestamp: 1000,
          usage: { input: 200, output: 20 },
        },
      },
    ],
  });
  flush();
  expect(view.container.querySelector(".msg-meta__tokens")?.textContent).toBe("↑200");
  expect(time.dateTime).toBe("1970-01-01T00:00:01.000Z");
  expect(time.textContent).toBe("6m ago");
  expect(observer.takeRecords()).toEqual([]);
  observer.disconnect();
  clock.mockRestore();
  expect(calendarFormat).not.toHaveBeenCalled();
  calendarFormat.mockRestore();
});
