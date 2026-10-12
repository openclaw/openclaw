/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
} from "../../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { LitContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";
import type { ControlUiPluginCapability } from "../../../plugins/control-ui-capability.ts";
import "../../../plugins/control-ui-view.solid.tsx";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup, type NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import { renderActivityGroup } from "./chat-message-group.ts";
import { createMessageGroup, createToolResultMessage } from "./chat-message.test-support.ts";

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
  const view = mountSolid(() => <LitContent value={renderActivityGroup([group], options())} />);
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
  const provider = createApplicationContextProvider(context);
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
      <SolidContentPresentation value={active}>
        <MessageGroup group={group()} options={options()} />
      </SolidContentPresentation>
    ),
    { baseElement: document.createElement("div") },
  );
  const nextListeners = new Set<() => void>();
  const nextProvider = createApplicationContextProvider({
    ...context,
    plugins: {
      ...context.plugins,
      subscribe: (listener) => {
        nextListeners.add(listener);
        return () => nextListeners.delete(listener);
      },
    },
  });
  flush();
  provider.append(view.container);
  document.body.append(provider, nextProvider);
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
    await waitForSolid(() => expect(latest?.signal).toBe(mountedSignal));
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
    // Parking disconnects the range before it moves to another context owner.
    selected = replacement;
    for (const listener of listeners) {
      listener();
    }
    setActive(false);
    flush();
    expect(listeners.size).toBe(0);
    nextProvider.append(view.container);
    setActive(true);
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Selected tool renderer"),
    );
    expect(nextListeners.size).toBeGreaterThan(0);
    expect(listeners.size).toBe(0);
    const reconnectedSignal = latest?.signal;
    view.unmount();
    // The Solid bridge distinguishes a same-turn move from actual removal.
    await Promise.resolve();
    flush();
    expect(reconnectedSignal?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect(nextListeners.size).toBe(0);
  } finally {
    view.unmount();
    provider.remove();
    nextProvider.remove();
  }
});
