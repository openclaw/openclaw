/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  buildFallbackSlashCommands,
  getSkillCommandCompletions,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { adjustTextareaHeight } from "../chat/components/chat-composer-dom.ts";
import { createNewSessionComposerTextarea } from "./composer-textarea.ts";
import {
  composerContext,
  renderComposer,
  resetComposerTestFixtures,
} from "./composer.test-support.ts";

function getComposerTextarea(composer: HTMLElement): HTMLTextAreaElement {
  const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("Expected composer textarea");
  }
  return textarea;
}

function createDragEvent(type: string, files: File[] = [], types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types },
  });
  return event;
}

function enter(textarea: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    ...options,
  });
  textarea.dispatchEvent(event);
  return event;
}

function typeDraft(textarea: HTMLTextAreaElement, value: string, settle = true) {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  if (settle) {
    flush();
  }
}

const skill = (name: string) => ({
  key: name,
  name,
  description: name,
  source: "skill" as const,
  skillModelVisible: true,
});

afterEach(() => {
  resetComposerTestFixtures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("new-session placeholder animation", () => {
  it("preserves animation progress through draft refreshes and cancels it with the input", () => {
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const view = renderComposer();
    document.body.append(view.container);
    const textarea = getComposerTextarea(view.composer);
    const target = textarea.getAttribute("aria-label")!;
    const advance = (timestamp: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback(timestamp);
      }
      flush();
    };

    advance(0);
    advance(206);
    expect(textarea.placeholder).toBe(target.slice(0, 1));
    view.rerender();
    advance(232);
    expect(textarea.placeholder).toBe(target.slice(0, 2));
    expect(view.container.querySelector("textarea")).toBe(textarea);

    view.unmount();
    expect(frames.size).toBe(0);
    view.container.remove();
  });
});

describe("new-session submission preview", () => {
  it("removes new-session file inputs and blocks dropped files under the Gateway upload policy", () => {
    const context = composerContext({ client: null });
    context.config.current.uploadsEnabled = false;
    const { container, composer, attachmentDraft } = renderComposer({
      context,
      message: "Keep typing",
    });
    expect(container.querySelector("input[type=file]")).toBeNull();
    expect(container.querySelector(".agent-chat__attach-menu-option")).toBeNull();
    const drop = createDragEvent("drop", [new File(["notes"], "notes.txt")]);
    composer.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(attachmentDraft.attachments).toEqual([]);
    expect(attachmentDraft.reads.pendingReads).toBe(0);
  });
});

describe("new-session composer keyboard submission", () => {
  it("opens slash commands and inserts the selected command with Enter", () => {
    replaceSlashCommands([
      {
        key: "test-command",
        name: "test-command",
        description: "Test command.",
      },
      {
        key: "local-command",
        name: "local-command",
        description: "Existing-session action.",
        executeLocal: true,
      },
    ]);
    const onSubmit = vi.fn();
    let message = "";
    const { composer } = renderComposer({
      onInput: (next) => {
        message = next;
      },
      onSubmit,
    });
    const textarea = getComposerTextarea(composer);

    typeDraft(textarea, "/");

    expect(composer.querySelector("#chat-new-session-slash-menu-listbox")?.textContent).toContain(
      "/test-command",
    );
    expect(
      composer.querySelector("#chat-new-session-slash-menu-listbox")?.textContent,
    ).not.toContain("/local-command");
    enter(textarea);
    expect(message).toBe("/test-command ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["keyboard", "pointer"])(
    "submits a selected non-skill command argument with %s",
    async (selection) => {
      replaceSlashCommands([
        {
          key: "mode",
          name: "mode",
          description: "Choose a mode.",
          args: "<mode>",
          argOptions: ["fast", "careful"],
        },
      ]);
      const onInput = vi.fn();
      const onSubmit = vi.fn();
      const { composer } = renderComposer({ onInput, onSubmit });
      const textarea = getComposerTextarea(composer);

      typeDraft(textarea, "/mode", false);
      if (selection === "keyboard") {
        enter(textarea);
      } else {
        flush();
        composer.querySelector<HTMLElement>(".slash-menu-item")?.click();
      }

      flush();
      expect(onInput).toHaveBeenLastCalledWith("/mode ");
      const fastOption = await waitForSolid(() => {
        const option = Array.from(composer.querySelectorAll<HTMLElement>(".slash-menu-item")).find(
          (item) => item.querySelector(".slash-menu-name")?.textContent?.trim() === "fast",
        );
        expect(option).toBeInstanceOf(HTMLElement);
        return option;
      });
      if (selection === "keyboard") {
        enter(textarea);
      } else {
        fastOption?.click();
      }

      expect(onInput).toHaveBeenLastCalledWith("/mode fast");
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it.each(["agent", "client"] as const)(
    "drops pending skill completion after %s replacement",
    async (owner) => {
      const response = createDeferred<CommandsListResult>();
      const request = vi.fn(() => response.promise);
      const snapshot = { client: { request } as unknown as GatewayBrowserClient };
      const context = composerContext(snapshot);
      const { composer, rerender, rerenderForAgent, composerTextarea } = renderComposer({
        agentId: "writer",
        context,
        message: "$",
      });
      const textarea = getComposerTextarea(composer);
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      expect(request).toHaveBeenCalledWith("commands.list", {
        agentId: "writer",
        includeArgs: true,
        scope: "text",
      });
      if (owner === "agent") {
        rerenderForAgent("reviewer");
      } else {
        snapshot.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
        rerender();
      }
      response.resolve({
        commands: [
          {
            acceptsArgs: true,
            description: "Previous owner only",
            name: "previous_owner_only",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/previous_owner_only"],
          },
        ],
      });
      await waitForFast(() =>
        expect(composerTextarea.skillMenu.state.skillCommandRefreshPending).toBe(false),
      );
      expect(composer.querySelector(".skill-menu")?.textContent ?? "").not.toContain(
        "previous_owner_only",
      );
      expect(getSkillCommandCompletions("previous_owner_only")).toEqual([]);
    },
  );

  it("opens skill mentions and inserts the selected skill with Enter", () => {
    replaceSlashCommands([skill("release_notes")]);
    let message = "";
    const { composer } = renderComposer({
      onInput: (next) => {
        message = next;
      },
    });
    const textarea = getComposerTextarea(composer);

    typeDraft(textarea, "$");

    expect(composer.querySelector(".skill-menu")?.textContent).toContain("release_notes");
    enter(textarea);
    expect(message).toBe("$release_notes ");
  });

  it("closes a skill menu when a route change replaces the owned draft", () => {
    replaceSlashCommands([skill("release_notes")]);
    const onSubmit = vi.fn();
    const { composer, rerenderForDraftRoute } = renderComposer({ onSubmit });

    const textarea = getComposerTextarea(composer);
    typeDraft(textarea, "$");
    expect(composer.querySelector(".skill-menu")).not.toBeNull();

    rerenderForDraftRoute("draft:two", "replacement task");
    flush();
    expect(composer.querySelector(".skill-menu")).toBeNull();

    enter(textarea);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("retargets inline slash completion when the caret moves without input", () => {
    replaceSlashCommands([skill("release_notes"), skill("office_hours")]);
    let message = "";
    const { composer } = renderComposer({
      onInput: (next) => {
        message = next;
      },
    });
    const textarea = getComposerTextarea(composer);

    typeDraft(textarea, "Use /release_ and /office_");
    expect(composer.querySelector(".slash-menu")?.textContent).toContain("/office_hours");

    const firstTokenCaret = "Use /release_".length;
    textarea.setSelectionRange(firstTokenCaret, firstTokenCaret);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    flush();
    expect(composer.querySelector(".slash-menu")?.textContent).toContain("/release_notes");
    enter(textarea);

    expect(message).toBe("Use $release_notes and /office_");
  });

  it("keeps Enter native when submission is silently gated", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      onSubmit,
    });
    const textarea = getComposerTextarea(composer);
    const event = enter(textarea);

    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe.each([false, true])("submission keys on mobile=%s", (mobile) => {
    beforeEach(() => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobile ? "Android" : "Windows");
    });
    it.each([
      ["Enter", false, false, false, false],
      ["Ctrl+Enter in Enter mode", false, true, false, false],
      ["Meta+Enter in Enter mode", false, false, true, false],
      ["Ctrl+Enter in modifier mode", true, true, false, false],
      ["Meta+Enter in modifier mode", true, false, true, false],
      ["Meta+Shift+Enter in Enter mode", false, false, true, true],
      ["Ctrl+Shift+Enter in modifier mode", true, true, false, true],
    ] as const)("handles %s", (_label, requiresModifier, ctrlKey, metaKey, background) => {
      const onSubmit = vi.fn();
      const onBackgroundSubmit = vi.fn();
      const { composer } = renderComposer({ onSubmit, onBackgroundSubmit, requiresModifier });
      const event = enter(getComposerTextarea(composer), {
        ctrlKey,
        metaKey,
        shiftKey: background,
      });
      expect(event.defaultPrevented).toBe(!mobile);
      expect(background ? onBackgroundSubmit : onSubmit).toHaveBeenCalledTimes(mobile ? 0 : 1);
      expect(background ? onSubmit : onBackgroundSubmit).not.toHaveBeenCalled();
      if (mobile) {
        composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit")!.click();
        expect(onSubmit).toHaveBeenCalledOnce();
        expect(onBackgroundSubmit).not.toHaveBeenCalled();
      }
    });
  });

  it("keeps an IME confirmation Enter from starting a session", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({ message: "日本語の入力", onSubmit });
    const textarea = getComposerTextarea(composer);
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const compositionEnd = new CompositionEvent("compositionend", { bubbles: true });
    textarea.dispatchEvent(compositionEnd);
    const confirmingEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      keyCode: 13,
    });
    Object.defineProperty(confirmingEnter, "timeStamp", { value: compositionEnd.timeStamp - 1 });
    textarea.dispatchEvent(confirmingEnter);

    expect(confirmingEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    const deliberateEnter = enter(textarea);
    expect(deliberateEnter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards Enter to onSubmit while a reasoned gate blocks submission", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "Restoring your last session setup…",
      onSubmit,
    });
    const textarea = getComposerTextarea(composer);
    const event = enter(textarea);

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps Start disabled and reports an attempted press to the owner", () => {
    const onSubmit = vi.fn();
    const onBlockedSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "Restoring your last session setup…",
      onSubmit,
      onBlockedSubmit,
    });
    const start = composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit");

    expect(start?.disabled).toBe(true);
    expect(start?.getAttribute("aria-disabled")).toBe("true");
    start?.click();
    expect(onSubmit).not.toHaveBeenCalled();
    start?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(onBlockedSubmit).toHaveBeenCalledOnce();
  });

  it("previews dictation in a locked draft and reserves the primary slot for Send", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      message: "Existing draft",
      dictationActive: true,
      dictationPreview: "Existing draft spoken words",
      dictationStatus: <div class="agent-chat__dictation-status">Listening…</div>,
      onSubmit,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");

    expect(textarea?.value).toBe("Existing draft spoken words");
    expect(textarea?.readOnly).toBe(true);
    expect(composer.querySelector(".agent-chat__dictation-status")?.textContent).toBe("Listening…");
    expect(composer.querySelector(".new-session-page__start-submit")).toBeNull();
    textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("new-session composer start control", () => {
  it("keeps the plain Start button unchanged when the terminal action is hidden", () => {
    const { composer } = renderComposer();

    expect(composer.querySelectorAll(".chat-send-btn")).toHaveLength(1);
    expect(composer.querySelector(".new-session-page__start-split")).toBeNull();
    expect(composer.querySelector("button[aria-label='Start in terminal']")).toBeNull();
  });

  it("marks the Start button busy while the session is starting", () => {
    const { composer } = renderComposer({ submitting: true });
    const start = composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit");

    expect(start?.getAttribute("aria-busy")).toBe("true");
    expect(start?.getAttribute("aria-label")).toBe("Starting…");
  });

  it.each(["button", "Enter"])("native terminal %s uses the sole primary submission", (action) => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({ nativeTerminal: true, onSubmit });
    const button = composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit")!;
    expect(button.getAttribute("aria-label")).toBe("Start in terminal");
    expect(composer.querySelectorAll(".chat-send-btn")).toHaveLength(1);
    expect(composer.querySelector('input[type="file"]')).toBeNull();
    if (action === "button") {
      button.click();
    } else {
      composer
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("new-session composer sizing lifecycle", () => {
  beforeEach(() => vi.spyOn(CSS, "supports").mockReturnValue(false));

  it("leaves native input geometry to the deferred sizing owner", () => {
    vi.spyOn(CSS, "supports").mockReturnValue(true);
    const { composer } = renderComposer();
    const textarea = getComposerTextarea(composer);
    const read = vi.fn(() => 42);
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: read });
    Object.defineProperty(textarea, "clientHeight", { configurable: true, get: read });

    textarea.value = "Native typing";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the shared fallback for non-pixel CSS caps", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 500 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "50vh",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("150px");
  });

  it("keeps one observer across controlled updates and remeasures programmatic drafts", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const resizeObserverConstructed = vi.fn();
    class TestResizeObserver {
      constructor() {
        resizeObserverConstructed();
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const composerTextarea = createNewSessionComposerTextarea();
    const onInput = vi.fn();
    const first = renderComposer({ composerTextarea, onInput });
    document.body.append(first.container);
    const textarea = getComposerTextarea(first.composer);
    let scrollHeightReads = 0;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 42;
      },
    });
    await Promise.resolve();
    const readsAfterAttach = scrollHeightReads;

    textarea.value = "typed";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(onInput).toHaveBeenCalledWith("typed");
    const readsAfterInput = scrollHeightReads;
    first.rerenderWithMessage("typed");
    await Promise.resolve();

    expect(first.container.querySelector("textarea")).toBe(textarea);
    expect(resizeObserverConstructed).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    expect(scrollHeightReads).toBe(readsAfterInput);

    first.rerenderWithMessage("restored programmatically");
    await Promise.resolve();

    expect(scrollHeightReads).toBeGreaterThan(readsAfterInput);
    expect(readsAfterAttach).toBeGreaterThan(0);
    expect(resizeObserverConstructed).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    composerTextarea.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
    first.container.remove();
  });
});

describe("new-session composer attachment drops", () => {
  it("rejects native file drops and pastes visibly and keeps restored attachments removable", async () => {
    const onUnsupportedAttachment = vi.fn();
    const { attachmentDraft, composer, rerender } = renderComposer({
      nativeTerminal: true,
      onUnsupportedAttachment,
    });
    const file = new File(["image"], "pic.png", { type: "image/png" });
    const drop = createDragEvent("drop", [file]);
    composer.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onUnsupportedAttachment).toHaveBeenCalledOnce();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file] } });
    composer.querySelector("textarea")?.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(onUnsupportedAttachment).toHaveBeenCalledTimes(2);
    expect(attachmentDraft.attachments).toEqual([]);
    attachmentDraft.restore([{ id: "old", fileName: "old.txt", mimeType: "text/plain" }]);
    rerender();
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(composer.querySelector('[aria-label*="Remove"]')).not.toBeNull(),
    );
    const remove = composer.querySelector<HTMLButtonElement>('[aria-label*="Remove"]');
    expect(remove?.disabled).toBe(false);
    remove?.click();
    expect(attachmentDraft.attachments).toEqual([]);
  });
  it("surfaces authorization reasons on the disabled submit control", () => {
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "This action requires operator.write access.",
    });
    const submitTooltip = composer.querySelector<HTMLElement>("openclaw-tooltip");

    expect((submitTooltip as HTMLElement & { content?: string })?.content).toBe(
      "This action requires operator.write access.",
    );
  });

  it("places the attachment menu in the composer footer", () => {
    const { composer } = renderComposer();
    const attachmentMenu = composer.querySelector<HTMLElement>(".agent-chat__attach-menu");

    expect(attachmentMenu?.closest(".agent-chat__composer-footer")).not.toBeNull();
    expect(attachmentMenu?.closest(".agent-chat__composer-input-row")).toBeNull();
  });

  it("keeps page-level incognito out of the composer when drafts are unavailable", () => {
    const { composer } = renderComposer();
    const switches = composer.querySelectorAll<HTMLButtonElement>('[role="switch"]');

    expect(switches).toHaveLength(0);
  });

  it("lets one draft pill replace page-level incognito", () => {
    const onVisibilityChange = vi.fn();
    const { composer } = renderComposer({
      draftAvailable: true,
      visibility: "draft",
      onVisibilityChange,
    });
    const draftPill = composer.querySelector<HTMLButtonElement>('[role="switch"]');
    const visibleDraftButtons = Array.from(
      composer.querySelectorAll<HTMLButtonElement>(".agent-chat__composer-footer button"),
    ).filter((button) => button.textContent?.trim() === "Draft");

    expect(draftPill?.textContent).toContain("Draft");
    expect(draftPill?.getAttribute("aria-checked")).toBe("true");
    expect(visibleDraftButtons).toEqual([draftPill]);

    draftPill?.click();
    expect(onVisibilityChange).toHaveBeenCalledWith("normal");
  });

  it("adds a dropped file through the shared attachment handling", async () => {
    const { attachmentDraft, composer } = renderComposer();
    const replace = vi.spyOn(attachmentDraft, "replace");
    const file = new File(["image"], "pic.png", { type: "image/png" });

    composer.dispatchEvent(createDragEvent("drop", [file]));

    await waitForFast(() => expect(replace).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith([
      expect.objectContaining({
        fileName: "pic.png",
        mimeType: "image/png",
        sizeBytes: file.size,
      }),
    ]);
    expect(attachmentDraft.attachments).toHaveLength(1);
    expect(attachmentDraft.attachments[0]).toMatchObject({
      fileName: "pic.png",
      mimeType: "image/png",
      sizeBytes: file.size,
    });
  });

  it("keeps the drop affordance balanced across nested drag targets", () => {
    const { composer } = renderComposer();

    composer.dispatchEvent(createDragEvent("dragenter"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(true);

    composer.dispatchEvent(createDragEvent("dragenter"));
    composer.dispatchEvent(createDragEvent("dragleave"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(true);

    composer.dispatchEvent(createDragEvent("dragleave"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);
  });

  it("keeps non-file drops native inside the textarea and cancels them elsewhere", () => {
    const { attachmentDraft, composer } = renderComposer();
    const replace = vi.spyOn(attachmentDraft, "replace");
    const textarea = getComposerTextarea(composer);

    const dragenter = createDragEvent("dragenter", [], ["text/plain"]);
    composer.dispatchEvent(dragenter);
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);

    const textareaDrop = createDragEvent("drop", [], ["text/plain"]);
    textarea.dispatchEvent(textareaDrop);
    expect(textareaDrop.defaultPrevented).toBe(false);

    const shellDrop = createDragEvent("drop", [], ["text/uri-list"]);
    composer.dispatchEvent(shellDrop);
    expect(shellDrop.defaultPrevented).toBe(true);
    expect(replace).not.toHaveBeenCalled();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    composer.append(checkbox);
    const checkboxDrop = createDragEvent("drop", [], ["text/uri-list"]);
    checkbox.dispatchEvent(checkboxDrop);
    expect(checkboxDrop.defaultPrevented).toBe(true);
  });

  it.each([
    { submitting: true, messageLocked: false },
    { submitting: false, messageLocked: true },
  ])("ignores drops while the composer is disabled", (disabled) => {
    const { attachmentDraft, composer } = renderComposer(disabled);
    const replace = vi.spyOn(attachmentDraft, "replace");
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const file = new File(["image"], "pic.png", { type: "image/png" });

    composer.dispatchEvent(createDragEvent("dragenter"));
    composer.dispatchEvent(createDragEvent("drop", [file]));

    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);
    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(attachmentDraft.attachments).toEqual([]);

    const textarea = getComposerTextarea(composer);
    expect(textarea.disabled).toBe(true);
    const disabledTextareaDrop = createDragEvent("drop", [], ["text/uri-list"]);
    textarea.dispatchEvent(disabledTextareaDrop);
    expect(disabledTextareaDrop.defaultPrevented).toBe(true);
  });
});

describe("new-session composer dictation insertion", () => {
  function draft(message = "ship it", value = message, start = value.length, end = start) {
    const { composer, composerTextarea } = renderComposer({ message });
    const textarea = getComposerTextarea(composer);
    textarea.value = value;
    textarea.setSelectionRange(start, end);
    return { textarea, composerTextarea };
  }

  it("inserts at the captured caret rather than its later position", () => {
    const { textarea, composerTextarea } = draft("ship it", "ship it", 4);
    composerTextarea.captureSelection();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    expect(composerTextarea.insertTranscript("please")).toBe("ship please it");
    expect(textarea.value).toBe("ship please it");
  });

  it("preserves edits made after Stop before inserting a late transcript", () => {
    const { textarea, composerTextarea } = draft("ship it", "ship it", 4);
    composerTextarea.captureSelection();
    textarea.value = "ship it today";
    textarea.setSelectionRange(4, 4);
    expect(composerTextarea.insertTranscript("please", true)).toBe("ship please it today");
    expect(textarea.value).toBe("ship please it today");
  });

  it.each([
    ["highlighted range", "ship the thing", "ship the thing", 5, 14, true, "it now", "ship it now"],
    ["uncaptured caret", "ship", "ship", 0, 0, false, "it", "ship it"],
    ["uncommitted keystrokes", "ship", "ship the", 8, 8, true, "thing", "ship the thing"],
  ] as const)(
    "inserts using the %s",
    (_label, message, value, start, end, capture, transcript, expected) => {
      const { composerTextarea } = draft(message, value, start, end);
      if (capture) {
        composerTextarea.captureSelection();
      }
      expect(composerTextarea.insertTranscript(transcript)).toBe(expected);
    },
  );

  it("leaves the draft alone for a blank transcript", () => {
    const { textarea, composerTextarea } = draft();
    composerTextarea.captureSelection();
    expect(composerTextarea.insertTranscript("   ")).toBeNull();
    expect(textarea.value).toBe("ship it");
  });

  it("spends a captured caret once, then appends", () => {
    const { composerTextarea } = draft("ship it", "ship it", 0);
    composerTextarea.captureSelection();
    expect(composerTextarea.insertTranscript("please")).toBe("please ship it");
    expect(composerTextarea.insertTranscript("now")).toBe("please ship it now");
  });

  it("previews without consuming or mutating the captured draft", () => {
    const { textarea, composerTextarea } = draft("ship it", "ship it", 4);
    composerTextarea.captureSelection();
    expect(composerTextarea.previewTranscript("please")).toBe("ship please it");
    expect(textarea.value).toBe("ship it");
    expect(composerTextarea.insertTranscript("please")).toBe("ship please it");
  });

  it("has nothing to insert into once the draft is gone", () => {
    const { composerTextarea } = draft();
    composerTextarea.captureSelection();
    composerTextarea.disconnect();
    expect(composerTextarea.insertTranscript("it")).toBeNull();
  });
});
