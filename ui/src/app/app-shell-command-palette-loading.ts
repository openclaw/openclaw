import { createMemo, createSignal, onSettled } from "solid-js";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  isCommandPaletteShortcut,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
  type CommandPaletteInputSnapshot,
  type CommandPaletteInputHandoff,
  type CommandPaletteOpenInput,
  type CommandPaletteMode,
} from "../components/command-palette-contract.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.tsx";
import { keepMobileReturnNative } from "../lib/browser-platform.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { showToast } from "../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../lib/uploads.ts";
import type { ShellNavigationCapability } from "./app-shell-navigation.ts";
import type { ApplicationContext } from "./context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import { lazyShellEvent, type LazyShellEvent } from "./lazy-shell-action.ts";

type CommandPaletteShellHost = {
  readonly context?: Pick<ApplicationContext, "gateway"> &
    Partial<Pick<ApplicationContext, "config">>;
  readonly elements: { commandPalette?: CommandPaletteElement };
  readonly commandPaletteTarget?: CommandPaletteTargetDetail;
  readonly shellNavigation: Pick<ShellNavigationCapability, "chatNavigationOptions" | "navigate">;
};

type CommandPaletteShellActions = {
  request(event: LazyShellEvent): void;
  clear(event: LazyShellEvent): void;
  cancel(): void;
  pending(): boolean;
};

/** Owns palette launch and dispatch; shared lazy-event persistence stays with shell chrome. */
export class ShellCommandPaletteOwner {
  readonly loading: CommandPaletteLoadingState;
  #scope: ReturnType<typeof gatewayPresentationScope> | undefined;
  readonly #host: CommandPaletteShellHost;
  readonly #actions: CommandPaletteShellActions;

  constructor(host: CommandPaletteShellHost, actions: CommandPaletteShellActions) {
    this.#host = host;
    this.#actions = actions;
    this.loading = createCommandPaletteLoading(host);
  }

  readonly open = (): void => {
    this.synchronizeScope();
    if (!this.loading.active() && this.loading.hasAttachments()) {
      this.loading.begin();
    }
    const palette = this.#host.elements.commandPalette;
    // Opening is an intent, not a prompt transport. Never persist event detail.
    const descriptor = lazyShellEvent(COMMAND_PALETTE_OPEN_EVENT);
    if (palette?.isConnected) {
      this.loading.handoff(() => {
        // The loader keeps keyboard custody until the replacement accepts focus.
        // Read its final value and recheck ownership at that boundary.
        if (this.loading.active()) {
          const take = this.loading.captureHandoff();
          palette.openPalette(() => {
            this.synchronizeScope();
            return take();
          });
        } else {
          palette.openPalette();
        }
        this.#actions.clear(descriptor);
      });
      return;
    }
    this.loading.begin();
    this.#actions.request(descriptor);
  };

  closePending(): void {
    this.#actions.cancel();
  }

  synchronizeScope(): void {
    const gateway = this.#host.context?.gateway;
    const scope = gateway ? gatewayPresentationScope(gateway) : undefined;
    if (this.#scope && this.#scope !== scope) {
      this.loading.clear();
      this.closePending();
    }
    this.#scope = scope;
  }

  toggle(): void {
    if (this.loading.active() || this.#actions.pending()) {
      this.closePending();
    } else if (this.loading.hasAttachments()) {
      this.open();
    } else if (this.#host.elements.commandPalette?.isConnected) {
      this.#host.elements.commandPalette.togglePalette();
    } else {
      this.open();
    }
  }

  handleSlashCommand(command: string): void {
    const host = this.#host;
    const chatHandler = host.commandPaletteTarget?.owner.isConnected
      ? host.commandPaletteTarget.onSlashCommand
      : null;
    if (chatHandler) {
      chatHandler(command);
      return;
    }
    // Chat can update its existing draft; other routes hand it through navigation.
    const navigation = host.shellNavigation.chatNavigationOptions("chat");
    const search = new URLSearchParams(navigation?.search ?? "");
    search.set("draft", command.endsWith(" ") ? command : `${command} `);
    host.shellNavigation.navigate("chat", { ...navigation, search: `?${search.toString()}` });
  }

  handlePendingShortcut(event: KeyboardEvent): boolean {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      (!this.loading.active() && !this.loading.hasAttachments()) ||
      !isCommandPaletteShortcut(event)
    ) {
      return false;
    }
    event.preventDefault();
    if (!event.repeat) {
      this.toggle();
    }
    return true;
  }
}

/** In-memory custody outlives the loading view, until the real palette accepts it. */
function createCommandPaletteLoading(host: Pick<CommandPaletteShellHost, "context">) {
  type Presentation = {
    mode: CommandPaletteMode;
    draft?: CommandPaletteInputSnapshot;
    returnFocus?: HTMLElement | null;
    submitRequested: boolean;
  };
  let current: Presentation = { mode: "search", submitRequested: false };
  // Reentrant shell events can publish during a rendering computation.
  const [read, write] = createSignal(current, { ownedWrite: true });
  // Imperative custody reads the same receipt before Solid commits its publication.
  const presentation = () => {
    read();
    return current;
  };
  const publish = (next: Presentation) => {
    current = next;
    write(next);
  };
  const active = () => current.returnFocus !== undefined;
  const shown = createMemo(() => read().returnFocus !== undefined);
  let attachmentFiles: File[] = [];
  let mentionTrigger: number | undefined;
  let input: HTMLTextAreaElement | undefined;
  let composing = false;
  let pendingHandoff: (() => void) | undefined;
  let compositionFrame: number | undefined;
  let handoffPending = false;
  let generation = 0;

  function cancelCompositionFrame() {
    if (compositionFrame !== undefined) {
      cancelAnimationFrame(compositionFrame);
      compositionFrame = undefined;
    }
  }
  function reset() {
    current = { mode: current.mode, submitRequested: false };
    generation += 1;
    handoffPending = false;
    cancelCompositionFrame();
    pendingHandoff = undefined;
    composing = false;
    input = undefined;
    attachmentFiles = [];
    mentionTrigger = undefined;
  }
  onSettled(() => reset);
  function snapshot(): CommandPaletteInputSnapshot | undefined {
    return input
      ? {
          value: input.value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          selectionDirection: input.selectionDirection,
        }
      : current.draft;
  }
  function nativeTextDrop(event: DragEvent): boolean {
    return (
      active() &&
      event.target === input &&
      !current.submitRequested &&
      !Array.from(event.dataTransfer?.types ?? []).includes("Files")
    );
  }
  function take(): CommandPaletteOpenInput | undefined {
    if (!active()) {
      return undefined;
    }
    const draft = snapshot() ?? {
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "none" as const,
    };
    const { returnFocus, submitRequested, mode } = current;
    const files = attachmentFiles;
    const trigger = mentionTrigger;
    // Transfer the original focus target without restoring it between the two inputs.
    input?.closest<OpenClawModalDialog>("openclaw-modal-dialog")?.setReturnFocusTarget(null);
    loading.clear();
    return {
      ...draft,
      mode,
      returnFocus,
      ...(submitRequested ? { submitRequested: true as const } : {}),
      ...(files.length ? { attachmentFiles: files } : {}),
      ...(trigger !== undefined ? { mentionTrigger: trigger } : {}),
    };
  }
  const loading = {
    active: () => {
      shown();
      return active();
    },
    value: () => presentation().draft?.value ?? "",
    mode: () => presentation().mode,
    setMode(mode: CommandPaletteMode): void {
      if (composing || current.submitRequested) {
        return;
      }
      mentionTrigger = undefined;
      publish({ ...current, mode });
      input?.focus({ preventScroll: true });
    },
    hasAttachments: () => {
      presentation();
      return attachmentFiles.length > 0;
    },
    submitRequested: () => presentation().submitRequested,
    waitingForComposition: () => handoffPending,
    begin(): void {
      publish({
        ...current,
        returnFocus: active()
          ? current.returnFocus
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      });
    },
    captureInput(_value?: string, event?: InputEvent): void {
      if (!active() || !input) {
        return;
      }
      if (
        current.mode === "compose" &&
        !composing &&
        !event?.isComposing &&
        event?.inputType === "insertText" &&
        event.data?.includes("@")
      ) {
        mentionTrigger = input.selectionStart - event.data.length + event.data.lastIndexOf("@");
      } else if (mentionTrigger !== undefined) {
        // Pasting/replacing a token cannot reopen a picker as a typed mention.
        const end = mentionTrigger + 1;
        if (
          event?.inputType === "insertFromPaste" ||
          event?.inputType === "insertFromDrop" ||
          current.draft?.value.slice(0, end) !== input.value.slice(0, end)
        ) {
          mentionTrigger = undefined;
        }
      }
      // The live field owns text and selection until replacement focus accepts it.
      publish({ ...current, draft: snapshot() });
    },
    inputRef(element: Element | undefined, previous?: HTMLTextAreaElement): void {
      if (previous && previous !== input) {
        return;
      }
      if (active() && input && input !== element) {
        publish({ ...current, draft: snapshot() });
      }
      if (!(element instanceof HTMLTextAreaElement)) {
        input = undefined;
        return;
      }
      if (!active()) {
        return;
      }
      input = element;
      const draft = current.draft;
      element
        .closest<OpenClawModalDialog>("openclaw-modal-dialog")
        ?.setReturnFocusTarget(current.returnFocus ?? null);
      // Binding precedes the ref; selection restoration must not steal picker focus.
      if (draft && !composing) {
        element.setSelectionRange(
          draft.selectionStart,
          draft.selectionEnd,
          draft.selectionDirection,
        );
      }
    },
    handleCompositionStart(): void {
      if (!active()) {
        return;
      }
      composing = true;
      mentionTrigger = undefined;
      cancelCompositionFrame();
    },
    handleCompositionEnd(): void {
      if (!active()) {
        return;
      }
      composing = false;
      cancelCompositionFrame();
      // compositionend may precede final input; take only when replacement focus accepts it.
      compositionFrame = requestAnimationFrame(() => {
        compositionFrame = undefined;
        const handoff = pendingHandoff;
        pendingHandoff = undefined;
        handoff?.();
      });
    },
    handlePaste(event: ClipboardEvent): void {
      if (!active() || current.submitRequested) {
        return;
      }
      const files = Array.from(event.clipboardData?.items ?? [], (item) => item.getAsFile()).filter(
        (file): file is File => file?.type.startsWith("image/") === true,
      );
      if (files.length) {
        event.preventDefault();
        if (!uploadsEnabled(host.context?.config)) {
          showToast({ message: uploadsDisabledMessage() });
          return;
        }
        attachmentFiles.push(...files);
        publish({ ...current, mode: "compose" });
      }
    },
    handleDragOver(event: DragEvent): void {
      if (nativeTextDrop(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          active() &&
          !current.submitRequested &&
          uploadsEnabled(host.context?.config) &&
          Array.from(event.dataTransfer.types).includes("Files")
            ? "copy"
            : "none";
      }
    },
    handleDrop(event: DragEvent): void {
      if (nativeTextDrop(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!active() || current.submitRequested || !event.dataTransfer?.files.length) {
        return;
      }
      if (!uploadsEnabled(host.context?.config)) {
        showToast({ message: uploadsDisabledMessage() });
        return;
      }
      // Keep raw Files in memory until the canonical draft owns admission/reads.
      attachmentFiles.push(...event.dataTransfer.files);
      publish({ ...current, mode: "compose" });
    },
    handleKeydown(event: KeyboardEvent): void {
      if (keepMobileReturnNative(event)) {
        return;
      }
      if (composing || event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      if (
        event.target === input &&
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          loading.setMode(current.mode === "search" ? "compose" : "search");
        }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (
          current.mode === "compose" &&
          !event.repeat &&
          (current.draft?.value.trim() || attachmentFiles.length > 0) &&
          matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event)
        ) {
          publish({ ...current, submitRequested: true });
        }
      }
    },
    handoff(open: () => void): void {
      if (composing || compositionFrame !== undefined) {
        handoffPending = true;
        pendingHandoff = open;
      } else {
        open();
      }
    },
    captureHandoff(): CommandPaletteInputHandoff {
      const captured = generation;
      return () => (captured === generation ? take() : undefined);
    },
    dismiss(): void {
      // Accepted files stay in this custody until the canonical draft takes them.
      // Dismissal cancels Send and composition, while context retirement clears all.
      const files = attachmentFiles;
      const draft = files.length ? snapshot() : undefined;
      reset();
      if (files.length) {
        attachmentFiles = files;
        current = { ...current, draft };
      }
      write(current);
    },
    clear(): void {
      reset();
      write(current);
    },
  };
  return loading;
}

export type CommandPaletteLoadingState = ReturnType<typeof createCommandPaletteLoading>;
