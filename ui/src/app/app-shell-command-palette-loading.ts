import { html } from "lit";
import {
  COMMAND_PALETTE_DIALOG_STYLE,
  COMMAND_PALETTE_OPEN_EVENT,
  isCommandPaletteShortcut,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
  type CommandPaletteInputSnapshot,
  type CommandPaletteInputHandoff,
  type CommandPaletteOpenInput,
} from "../components/command-palette-contract.ts";
import { renderCommandPaletteInput } from "../components/command-palette-input.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { t } from "../i18n/index.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import type {
  LazyCustomElementRequestController,
  OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { lazyShellEvent, type LazyShellEvent } from "./lazy-shell-action.ts";

type CommandPaletteShellHost = {
  readonly context?: Pick<ApplicationContext, "gateway">;
  readonly commandPalette?: CommandPaletteElement;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly commandPaletteTarget?: CommandPaletteTargetDetail;
  chatNavigationOptions(face: "chat"): ApplicationNavigationOptions | undefined;
  navigate(routeId: "chat", options?: ApplicationNavigationOptions): void;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  requestUpdate(): void;
};

type CommandPaletteShellActions = {
  request(element: OptionalCustomElement, event: LazyShellEvent, replay?: () => void): void;
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
    this.loading = new CommandPaletteLoadingState(host);
  }

  readonly open = (): void => {
    const palette = this.#host.commandPalette;
    // Opening is an intent, not a prompt transport. Never persist event detail.
    const descriptor = lazyShellEvent(COMMAND_PALETTE_OPEN_EVENT);
    if (palette) {
      this.loading.handoff(() => {
        // The loader keeps keyboard custody until the replacement accepts focus.
        // Read its final value and recheck ownership at that boundary.
        if (this.loading.active) {
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
    this.synchronizeScope();
    this.loading.begin();
    this.#actions.request(this.#host.commandPaletteElement, descriptor, this.open);
  };

  closePending(): void {
    this.#actions.cancel();
    this.#host.lazyCustomElements.abandon();
    this.#host.requestUpdate();
  }

  synchronizeScope(): void {
    const gateway = this.#host.context?.gateway;
    const scope = gateway ? gatewayPresentationScope(gateway) : undefined;
    if (this.#scope && this.#scope !== scope && (this.loading.active || this.#actions.pending())) {
      this.closePending();
    }
    this.#scope = scope;
  }

  toggle(): void {
    if (
      this.loading.active ||
      this.#host.lazyCustomElements.visibleState?.element === this.#host.commandPaletteElement
    ) {
      this.closePending();
    } else if (this.#host.commandPalette) {
      this.#host.commandPalette.togglePalette();
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
    const navigation = host.chatNavigationOptions("chat");
    const search = new URLSearchParams(navigation?.search ?? "");
    search.set("draft", command.endsWith(" ") ? command : `${command} `);
    host.navigate("chat", { ...navigation, search: `?${search.toString()}` });
  }

  handlePendingShortcut(event: KeyboardEvent): boolean {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      !this.loading.active ||
      !isCommandPaletteShortcut(event)
    ) {
      return false;
    }
    event.preventDefault();
    this.toggle();
    return true;
  }
}

/** In-memory custody of input until the real palette takes over. Never persisted. */
export class CommandPaletteLoadingState {
  submitRequested = false;
  #draft: CommandPaletteInputSnapshot | undefined;
  #input: HTMLTextAreaElement | undefined;
  #returnFocus: HTMLElement | null | undefined;
  #composing = false;
  #pendingHandoff: (() => void) | undefined;
  #compositionFrame: number | undefined;
  #handoffPending = false;
  #generation = 0;

  readonly #host: Pick<CommandPaletteShellHost, "requestUpdate">;

  constructor(host: Pick<CommandPaletteShellHost, "requestUpdate">) {
    this.#host = host;
  }

  get active(): boolean {
    return this.#returnFocus !== undefined;
  }

  get waitingForComposition(): boolean {
    return this.#handoffPending;
  }

  begin(): void {
    if (!this.active) {
      this.#returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }

  get value(): string {
    return this.#draft?.value ?? "";
  }

  #snapshot(): CommandPaletteInputSnapshot | undefined {
    const input = this.#input;
    return input
      ? {
          value: input.value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          selectionDirection: input.selectionDirection,
        }
      : this.#draft;
  }

  readonly captureInput = (): void => {
    if (!this.active || !this.#input) {
      return;
    }
    // The live field owns text and selection until replacement focus accepts it.
    this.#draft = this.#snapshot();
    this.#host.requestUpdate();
  };

  readonly inputRef = (element: Element | undefined): void => {
    if (!(element instanceof HTMLTextAreaElement)) {
      if (this.active && this.#input) {
        this.#draft = this.#snapshot();
      }
      this.#input = undefined;
      return;
    }
    if (!this.active) {
      return;
    }
    this.#input = element;
    const draft = this.#draft;
    element
      .closest<OpenClawModalDialog>("openclaw-modal-dialog")
      ?.setReturnFocusTarget(this.#returnFocus ?? null);
    // The shared renderer binds value before this ref; the modal alone owns
    // autofocus. Restoring selection here cannot steal a later picker focus.
    if (draft && !this.#composing) {
      element.setSelectionRange(draft.selectionStart, draft.selectionEnd, draft.selectionDirection);
    }
  };

  readonly handleCompositionStart = (): void => {
    if (!this.active) {
      return;
    }
    this.#composing = true;
    if (this.#compositionFrame !== undefined) {
      cancelAnimationFrame(this.#compositionFrame);
      this.#compositionFrame = undefined;
    }
  };

  readonly handleCompositionEnd = (): void => {
    if (!this.active) {
      return;
    }
    this.#composing = false;
    if (this.#compositionFrame !== undefined) {
      cancelAnimationFrame(this.#compositionFrame);
    }
    // compositionend can precede the final input event. Keep the live field for
    // that commit, and read it only when replacement focus accepts the handoff.
    this.#compositionFrame = requestAnimationFrame(() => {
      this.#compositionFrame = undefined;
      const handoff = this.#pendingHandoff;
      this.#pendingHandoff = undefined;
      handoff?.();
    });
  };

  readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.#composing || event.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (
        !event.repeat &&
        this.value.trim() &&
        matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event)
      ) {
        this.submitRequested = true;
        this.#host.requestUpdate();
      }
    }
  };

  handoff(open: () => void): void {
    if (this.#composing || this.#compositionFrame !== undefined) {
      this.#handoffPending = true;
      this.#pendingHandoff = open;
    } else {
      open();
    }
  }

  captureHandoff(): CommandPaletteInputHandoff {
    const generation = this.#generation;
    return () => (generation === this.#generation ? this.#take() : undefined);
  }

  #take(): CommandPaletteOpenInput | undefined {
    if (!this.active) {
      return undefined;
    }
    const draft = this.#snapshot() ?? {
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "none" as const,
    };
    const returnFocus = this.#returnFocus;
    const submitRequested = this.submitRequested;
    // Retiring the loader must not restore the original field between the two
    // palette inputs. The replacement dialog inherits that original target.
    this.#input?.closest<OpenClawModalDialog>("openclaw-modal-dialog")?.setReturnFocusTarget(null);
    this.clear();
    this.#host.requestUpdate();
    return {
      ...draft,
      returnFocus,
      ...(submitRequested ? { submitRequested: true as const } : {}),
    };
  }

  clear(): void {
    this.submitRequested = false;
    this.#generation += 1;
    this.#handoffPending = false;
    if (this.#compositionFrame !== undefined) {
      cancelAnimationFrame(this.#compositionFrame);
      this.#compositionFrame = undefined;
    }
    this.#pendingHandoff = undefined;
    this.#composing = false;
    this.#input = undefined;
    this.#draft = undefined;
    this.#returnFocus = undefined;
  }
}

export function renderCommandPaletteLoading(
  state: CommandPaletteLoadingState,
  onClose: () => void,
) {
  const label = t("palette.placeholder");
  return html`<openclaw-modal-dialog
    class="cmd-palette-overlay palette"
    label=${label}
    style=${COMMAND_PALETTE_DIALOG_STYLE}
    @modal-cancel=${onClose}
  >
    <div
      class="cmd-palette"
      aria-busy="true"
      @compositionstart=${state.handleCompositionStart}
      @compositionend=${state.handleCompositionEnd}
      @keydown=${state.handleKeydown}
    >
      ${renderCommandPaletteInput({
        value: state.value,
        placeholder: label,
        onInputRef: state.inputRef,
        onValueChange: state.captureInput,
        readOnly: state.submitRequested,
      })}
      <div class="cmd-palette__empty" role="status">${t("common.loading")}</div>
    </div>
  </openclaw-modal-dialog>`;
}
