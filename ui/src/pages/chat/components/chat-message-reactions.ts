import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { isReactionEmoji } from "../../../../../packages/gateway-protocol/src/index.js";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { sessionEmojiPickerShortcut } from "../../../components/session-icon-picker.ts";
import { syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import {
  GroupMessageReactions,
  type renderSolidGroupMessageReactions,
} from "./chat-message-reaction-chips-view.tsx";
import type { MessageReactionPlacement } from "./chat-message-reaction-model.ts";

export {
  GroupMessageReactions,
  renderSolidGroupMessageReactions,
} from "./chat-message-reaction-chips-view.tsx";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "🚀", "😂"] as const;

const addReactionIcon = strokeIcon(svg`<path d="M21 11.5a9 9 0 1 1-8.5-8.5"/>
  <path d="M8 14s1.5 2 4 2 4-2 4-2M16 5h6M19 2v6"/>
  <path d="M9 9h.01M15 9h.01"/>`);

export function renderGroupMessageReactions(
  ...args: Parameters<typeof renderSolidGroupMessageReactions>
) {
  return solidContent(GroupMessageReactions, {
    group: args[0],
    actionDetails: args[1],
    isStreaming: args[2],
    options: args[3],
  });
}

class MessageReactionPicker extends OpenClawLitElement {
  @property({ attribute: false }) onSelect?: (emoji: string, remove: boolean) => void;
  @property({ attribute: false }) activeEmoji: ReadonlySet<string> = new Set();
  @property() placement: MessageReactionPlacement = "bottom-start";
  @property({ type: Boolean, reflect: true }) compact = false;
  @state() private custom = false;
  @state() private value = "";
  @state() private invalid = false;

  static override styles = css`
    :host {
      display: inline-flex;
    }
    button,
    input {
      font: inherit;
      color: var(--text);
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      cursor: default;
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    input:focus-visible {
      outline: none;
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    }
    .trigger {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: var(--radius-md);
      color: var(--muted);
      transition:
        color 120ms ease,
        background-color 120ms ease;
    }
    .trigger svg {
      width: 14px;
      height: 14px;
    }
    .trigger:hover,
    .trigger[aria-expanded="true"] {
      color: var(--accent);
      background: var(--bg-hover);
    }
    :host([compact]) .trigger {
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      background: var(--bg-elevated);
    }
    :host([compact]) .trigger:hover,
    :host([compact]) .trigger[aria-expanded="true"] {
      border-color: var(--accent);
      background: var(--accent-subtle);
    }
    wa-popover {
      --arrow-size: 0;
    }
    wa-popover::part(body) {
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      background: var(--popover);
      color: var(--text);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.08),
        0 12px 32px rgba(0, 0, 0, 0.16);
    }
    wa-popover.custom::part(body) {
      border-radius: var(--radius-md);
    }
    .palette {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .palette .emoji {
      width: 34px;
      height: 34px;
      border-radius: var(--radius-full);
      font-size: 20px;
      line-height: 1;
      transition:
        transform 120ms ease,
        background-color 120ms ease;
    }
    .palette .emoji:hover {
      background: var(--bg-hover);
      transform: scale(1.18);
    }
    .palette .emoji[aria-pressed="true"] {
      background: var(--accent-subtle);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .divider {
      width: 1px;
      height: 20px;
      margin: 0 3px;
      background: var(--border);
    }
    .more,
    .back {
      border-radius: var(--radius-full);
      color: var(--muted);
    }
    .more:hover,
    .back:hover {
      color: var(--text);
      background: var(--bg-hover);
    }
    .more {
      width: 30px;
      height: 30px;
    }
    .more svg {
      width: 16px;
      height: 16px;
    }
    .custom {
      width: 236px;
      padding: 2px;
    }
    .custom-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .back {
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
    }
    .back svg {
      width: 14px;
      height: 14px;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg);
      font-size: 18px;
      line-height: 1;
    }
    input::placeholder {
      font-size: 13px;
      color: var(--muted);
    }
    input[aria-invalid="true"] {
      border-color: var(--accent);
    }
    .hint {
      margin: 6px 4px 2px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    @media (prefers-reduced-motion: reduce) {
      .trigger,
      .palette .emoji {
        transition: none;
      }
      .palette .emoji:hover {
        transform: none;
      }
    }
  `;

  private close() {
    const popover = this.renderRoot.querySelector<WaPopover>("wa-popover");
    if (popover) {
      popover.open = false;
    }
  }

  private select(emoji: string) {
    this.onSelect?.(emoji, this.activeEmoji.has(emoji));
    this.close();
  }

  private applyCustom(): void {
    const candidate = this.value.trim();
    if (isReactionEmoji(candidate)) {
      this.select(candidate);
      return;
    }
    this.invalid = candidate.length > 0;
  }

  private async showCustom(): Promise<void> {
    this.custom = true;
    await this.updateComplete;
    this.renderRoot.querySelector("input")?.focus();
  }

  private async showPalette(): Promise<void> {
    this.custom = false;
    this.value = "";
    this.invalid = false;
    await this.updateComplete;
    this.focusPalette();
  }

  private focusPalette(): void {
    const buttons = this.paletteButtons();
    (
      buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0]
    )?.focus();
  }

  private paletteButtons(): HTMLButtonElement[] {
    return [...this.renderRoot.querySelectorAll<HTMLButtonElement>(".palette button")];
  }

  private movePaletteFocus(event: KeyboardEvent): void {
    const buttons = this.paletteButtons();
    const active = this.shadowRoot?.activeElement;
    const current = buttons.findIndex((button) => button === active);
    const target =
      event.key === "ArrowRight"
        ? (current + 1) % buttons.length
        : event.key === "ArrowLeft"
          ? (current - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    if (target >= 0) {
      event.preventDefault();
      buttons[target]?.focus();
    }
  }

  private renderPalette() {
    return html`<div
      class="palette"
      role="group"
      aria-label=${t("chat.reactions.quick")}
      @keydown=${(event: KeyboardEvent) => this.movePaletteFocus(event)}
    >
      ${QUICK_REACTIONS.map(
        (emoji) => html`<button
          class="emoji"
          type="button"
          aria-label=${emoji}
          aria-pressed=${String(this.activeEmoji.has(emoji))}
          @click=${() => this.select(emoji)}
        >
          ${emoji}
        </button>`,
      )}
      <span class="divider" aria-hidden="true"></span>
      <openclaw-tooltip .content=${t("chat.reactions.more")}>
        <button
          class="more"
          type="button"
          aria-label=${t("chat.reactions.more")}
          @click=${() => void this.showCustom()}
        >
          ${icons.moreHorizontal}
        </button>
      </openclaw-tooltip>
    </div>`;
  }

  private renderCustom() {
    const shortcut = sessionEmojiPickerShortcut()?.join("");
    return html`<div class="custom">
      <div class="custom-row">
        <button
          class="back"
          type="button"
          aria-label=${t("chat.reactions.back")}
          @click=${() => void this.showPalette()}
        >
          ${icons.arrowLeft}
        </button>
        <input
          aria-label=${t("chat.reactions.emoji")}
          aria-invalid=${String(this.invalid)}
          autocomplete="off"
          placeholder=${t("chat.reactions.placeholder")}
          .value=${this.value}
          @input=${(event: InputEvent) => {
            if (!(event.currentTarget instanceof HTMLInputElement)) {
              return;
            }
            this.value = event.currentTarget.value;
            this.invalid = false;
            // The OS picker inserts exactly one emoji; applying it immediately
            // saves a keystroke. An IME candidate is not committed yet, so wait
            // for compositionend instead of reacting with a transient guess.
            if (!event.isComposing && isReactionEmoji(this.value.trim())) {
              this.applyCustom();
            }
          }}
          @compositionend=${(event: CompositionEvent) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              this.value = event.currentTarget.value;
            }
            if (isReactionEmoji(this.value.trim())) {
              this.applyCustom();
            }
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              this.applyCustom();
            } else if (event.key === "Backspace" && !this.value) {
              event.preventDefault();
              void this.showPalette();
            }
          }}
        />
      </div>
      <p class="hint" aria-live="polite">
        ${
          this.invalid
            ? t("chat.reactions.invalid")
            : shortcut
              ? t("chat.reactions.shortcut", { shortcut })
              : t("chat.reactions.hint")
        }
      </p>
    </div>`;
  }

  override render() {
    return html`
      <openclaw-tooltip .content=${t("chat.reactions.add")}>
        <button
          id="reaction-trigger"
          class="trigger"
          type="button"
          aria-label=${t("chat.reactions.add")}
          aria-haspopup="dialog"
          aria-expanded="false"
        >
          ${addReactionIcon}
        </button>
      </openclaw-tooltip>
      <wa-popover
        class="chat-reaction-picker ${this.custom ? "custom" : ""}"
        for="reaction-trigger"
        placement=${this.placement}
        distance="6"
        without-arrow
        aria-label=${t("chat.reactions.add")}
        ${ref(syncPopoverLabel)}
        @wa-show=${(event: Event) => {
          if (event.currentTarget instanceof WaPopover) {
            event.currentTarget.anchor?.setAttribute("aria-expanded", "true");
          }
        }}
        @wa-after-show=${() => this.focusPalette()}
        @wa-hide=${(event: Event) => {
          if (event.currentTarget instanceof WaPopover) {
            event.currentTarget.anchor?.setAttribute("aria-expanded", "false");
          }
        }}
        @wa-after-hide=${() => {
          this.custom = false;
          this.value = "";
          this.invalid = false;
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            this.close();
          }
        }}
      >
        ${this.custom ? this.renderCustom() : this.renderPalette()}
      </wa-popover>
    `;
  }
}

if (!customElements.get("openclaw-message-reaction-picker")) {
  customElements.define("openclaw-message-reaction-picker", MessageReactionPicker);
}
