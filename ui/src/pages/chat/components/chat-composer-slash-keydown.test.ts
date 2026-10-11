/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../../lib/chat/commands.ts";
import { createGoalComposerController } from "./chat-composer-goal-mode.ts";
import { createComposerKeyDownHandler } from "./chat-composer-keydown.ts";
import {
  renderSlashMenu,
  updateSlashMenu,
  type SlashMenuHost,
} from "./chat-composer-slash-menu.ts";
import {
  commitComposerDraft,
  composerDraftKey,
  getChatComposerState,
  resetChatComposerState,
} from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

function fixture(value: string, caret = value.length) {
  const container = document.createElement("div");
  const textarea = document.createElement("textarea");
  const menu = document.createElement("div");
  container.append(textarea, menu);
  document.body.append(container);
  let draft = value;
  const props: ChatComposerProps = {
    paneId: "slash-keydown",
    sessionKey: "session",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft: value,
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "OpenClaw",
    getDraft: () => draft,
    onDraftChange: (next) => {
      draft = next;
    },
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
    onGoalSubmit: vi.fn(async () => false),
  };
  const state = getChatComposerState(props.paneId);
  state.composerTextarea = textarea;
  state.composerDraftScopeKey = composerDraftKey(props);
  state.slashCommandDispatchConnected = true;
  const requestUpdate = () => render(renderSlashMenu(state, host, draft, requestUpdate), menu);
  const goalComposer = createGoalComposerController(props, state, requestUpdate);
  const host: SlashMenuHost = {
    paneId: props.paneId,
    getDraft: () => draft,
    getTextarea: () => textarea,
    commitDraft: (next) => commitComposerDraft(props, next),
    resolveArgOptions: (command) => command.argOptions ?? [],
    canRun: () => true,
    runCommand: vi.fn(goalComposer.submitCommand),
    runInlineCommand: vi.fn(),
    activateComposerMode: goalComposer.activateCommand,
  };
  const mentionMenuHost = { ...host, getMentions: () => [] };
  const handleKeydown = createComposerKeyDownHandler({
    state,
    props,
    skillMenuHost: host,
    slashMenuHost: host,
    mentionMenuHost,
    requestUpdate,
    sendShortcut: "enter",
    canSubmitDraft: (next) => Boolean(next.trim()),
    syncDraftAfterSend: vi.fn(),
    showAbortableUi: false,
    goalComposer,
  });
  textarea.addEventListener("keydown", handleKeydown);
  textarea.addEventListener("input", () => {
    commitComposerDraft(props, textarea.value);
    if (!goalComposer.active) {
      updateSlashMenu(textarea.value, state, host, requestUpdate);
    }
  });
  const input = (next: string, position = next.length) => {
    textarea.value = next;
    textarea.selectionStart = textarea.selectionEnd = position;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const key = (pressedKey: string) => {
    const event = new KeyboardEvent("keydown", {
      key: pressedKey,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  input(value, caret);
  return { container, textarea, state, host, props, goalComposer, input, key };
}

beforeEach(() => replaceSlashCommands(buildFallbackSlashCommands()));
afterEach(() => {
  resetChatComposerState("slash-keydown");
  document.body.replaceChildren();
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("composer keydown slash completion ownership", () => {
  it.each([
    ["/name /statu after", "/name after"],
    ["/name Draft /statu after", "/name Draft after"],
  ])("dispatches the visible command on Enter in %s", async (draft, remaining) => {
    const view = fixture(draft, draft.indexOf(" after"));
    expect(view.state.slashMenuOpen).toBe(true);
    expect(view.container.querySelector('[id$="slash-option-command-status"]')).not.toBeNull();
    expect(view.key("Enter").defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/status");
    expect(view.textarea.value).toBe(remaining);
    expect(view.props.getDraft?.()).toBe(remaining);
    expect(view.props.onSend).not.toHaveBeenCalled();
  });

  it.each(["/name /statu after", "/name Draft /statu after"])(
    "retains click and Tab selection for %s",
    (draft) => {
      const caret = draft.indexOf(" after");
      const view = fixture(draft, caret);
      expect(view.key("Tab").defaultPrevented).toBe(true);
      expect(view.textarea.value).toBe(draft.replace("/statu", "/status"));
      expect(view.host.runInlineCommand).not.toHaveBeenCalled();
      view.input(draft, caret);
      view.container.querySelector<HTMLElement>('[id$="slash-option-command-status"]')?.click();
      expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/status");
      expect(view.textarea.value).toBe(draft.replace("/statu ", ""));
      expect(view.props.onSend).not.toHaveBeenCalled();
    },
  );

  it("keeps a visible inline finite-argument menu ahead of direct inference", () => {
    const draft = "/name /verbose after";
    const view = fixture(draft, draft.indexOf(" after"));
    view.key("Enter");
    expect(view.state.slashMenuMode).toBe("args");
    expect(view.state.slashMenuCommand?.name).toBe("verbose");
    view.key("Enter");
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/verbose on");
    expect(view.textarea.value).toBe("/name after");
    expect(view.props.onSend).not.toHaveBeenCalled();
  });

  it("preserves active freeform collection when its argument contains a slash token", async () => {
    const view = fixture("Draft /name");
    view.key("Enter");
    await Promise.resolve();
    expect(view.state.slashMenuMode).toBe("freeform-args");
    view.input("Draft /name title /statu");
    expect(view.state.slashMenuOpen).toBe(false);
    view.key("Enter");
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/name title /statu");
    expect(view.textarea.value).toBe("Draft ");
    expect(view.props.onSend).not.toHaveBeenCalled();
  });

  it("still infers a direct freeform invocation when no completion menu is open", () => {
    const draft = "Draft /name Title after";
    const view = fixture(draft, draft.indexOf(" after"));
    expect(view.state.slashMenuOpen).toBe(false);
    view.key("Enter");
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/name Title");
    expect(view.textarea.value).toBe("Draft after");
  });

  it("keeps ordinary goal argument Enter dispatch unchanged", () => {
    const view = fixture("/goal stat");
    expect(view.state.slashMenuMode).toBe("args");
    view.key("Enter");
    expect(view.props.getDraft?.()).toBe("/goal status");
    expect(view.props.onSend).toHaveBeenCalledOnce();
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
  });

  it("submits slash-like objective text through the active Goal controller", async () => {
    const view = fixture("");
    view.goalComposer.begin();
    await Promise.resolve();
    view.input("/name /statu after");
    expect(view.goalComposer.active).toBe(true);
    expect(view.key("Enter").defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(view.props.onGoalSubmit).toHaveBeenCalledWith(
      { action: "start", objective: "/name /statu after" },
      expect.any(KeyboardEvent),
    );
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
    expect(view.props.onSend).not.toHaveBeenCalled();
    expect(view.textarea.value).toBe("/name /statu after");
  });
});
