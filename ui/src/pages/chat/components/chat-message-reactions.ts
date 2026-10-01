import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { property, state as litState } from "lit/decorators.js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { configureAnchoredPopup } from "../../../components/anchored-overlay.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/modal-dialog.ts";
import { focusWithoutTooltip } from "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { emojiForShortcode, suggestEmoji } from "../../../lib/chat/emoji.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "../../../styles/chat/reactions.css";

const MAX_INLINE_REACTIONS = 8;
const QUICK_EMOJI = ["thumbsup", "heart", "joy", "tada", "eyes", "rocket", "fire", "clap"];
const ADD_REACTION_ICON = strokeIcon(svg`<path d="M22 11v1a10 10 0 1 1-9-10" />
  <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6" />`);

export type MessageReactionAction = (messageId: string, emoji: string, remove: boolean) => void;
export type MessageReactionOptions = {
  messageReactions?: ReadonlyMap<string, MessageReactionSummary[]>;
  userId?: string | null;
  onReact?: MessageReactionAction;
  pendingReactionMessageIds?: ReadonlyMap<string, unknown>;
};

/** Presentation only: the pane owns reads, events, writes, pending state, and errors. */
export class ChatMessageReactions extends OpenClawLightDomElement {
  @property({ attribute: false }) reactions: readonly MessageReactionSummary[] = [];
  @property({ attribute: false }) userId?: string | null;
  @property({ attribute: false }) onReact?: MessageReactionAction;
  @property({ type: Boolean }) pending = false;
  @property({ attribute: false }) actions: TemplateResult | typeof nothing = nothing;
  @property() messageId = "";
  @property({ reflect: true }) layout: "user" | "assistant" = "assistant";
  @litState() private expanded = false;
  @litState() private inlineCount = MAX_INLINE_REACTIONS;
  private resizeObserver?: ResizeObserver;
  private measuredStrip?: HTMLElement;
  private measuredChips?: HTMLElement;
  private measureFrame = 0;
  private peopleReturnTarget: HTMLButtonElement | null = null;
  @litState() private pickerOpen = false;
  @litState() private query = "";
  @litState() private peopleEmoji: string | null = null;
  private pickerNeedsFocus = false;
  private presentationGeneration = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.measuredStrip = undefined;
    this.measuredChips = undefined;
    cancelAnimationFrame(this.measureFrame);
    this.measureFrame = 0;
    this.expanded = false;
    this.closeDialogs();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("messageId") || changed.has("userId")) {
      this.presentationGeneration += 1;
      this.expanded = false;
      this.closeDialogs();
    }
  }

  private closeDialogs() {
    this.closePicker();
    this.peopleEmoji = null;
  }

  private ownReaction(reaction: MessageReactionSummary) {
    return reaction.identities.some((identity) => identity.id === this.userId);
  }

  private selectEmoji(emoji: string) {
    if (this.pending || !this.onReact) {
      return;
    }
    this.closePicker(this.pickerOpen);
    const remove = this.reactions.some(
      (reaction) => reaction.emoji === emoji && this.ownReaction(reaction),
    );
    this.onReact(this.messageId, emoji, remove);
  }

  private names(reaction: MessageReactionSummary) {
    const names = reaction.identities
      .slice(0, 3)
      .map((identity) => identity.label ?? identity.id)
      .join(", ");
    const remaining = reaction.identities.length - 3;
    return t(remaining > 0 ? "chat.reactions.namesMore" : "chat.reactions.names", {
      names,
      count: String(remaining),
      emoji: reaction.emoji,
    });
  }

  private closePicker(restoreFocus = false) {
    this.pickerOpen = false;
    this.pickerNeedsFocus = false;
    this.ownerDocument.removeEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.removeEventListener("focusin", this.dismissPickerOutside, true);
    if (restoreFocus) {
      this.querySelector<HTMLButtonElement>(".chat-reaction-add")?.focus({ preventScroll: true });
    }
  }

  private readonly dismissPickerOutside = (event: Event) => {
    const path = event.composedPath();
    const popup = this.querySelector("wa-popup");
    const trigger = this.querySelector(".chat-reaction-add");
    if ((!popup || !path.includes(popup)) && (!trigger || !path.includes(trigger))) {
      this.closePicker();
    }
  };

  private togglePicker() {
    if (this.pickerOpen) {
      this.closePicker();
      return;
    }
    this.query = "";
    this.pickerOpen = true;
    this.pickerNeedsFocus = true;
    this.ownerDocument.addEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.addEventListener("focusin", this.dismissPickerOutside, true);
  }

  protected override updated() {
    if (!this.isConnected) {
      return;
    }
    this.observeLayout();
    const modal = this.querySelector("openclaw-modal-dialog");
    if (modal && this.peopleEmoji) {
      modal.setReturnFocusTarget(
        this.peopleReturnTarget?.isConnected
          ? this.peopleReturnTarget
          : ([...this.querySelectorAll<HTMLButtonElement>(".chat-reaction-toggle")].find(
              (button) => button.dataset.emoji === this.peopleEmoji,
            ) ??
              this.querySelector<HTMLButtonElement>(
                "button.chat-reaction-more, .chat-reaction-add",
              )),
      );
    }
    const popup = this.querySelector<WaPopup>("wa-popup");
    const trigger = this.querySelector<HTMLButtonElement>(".chat-reaction-add");
    if (popup && trigger && this.pickerOpen) {
      configureAnchoredPopup(popup, trigger, "top", "center");
    }
  }

  private readonly focusPicker = () => {
    if (this.pickerOpen && this.pickerNeedsFocus) {
      this.pickerNeedsFocus = false;
      // Emoji choices come first; do not summon the mobile keyboard until Search is tapped.
      this.querySelector<HTMLButtonElement>(".chat-reaction-picker button")?.focus({
        preventScroll: true,
      });
    }
  };

  private prepareReactionPointer(this: void, event: PointerEvent) {
    const trigger = event.currentTarget as HTMLButtonElement;
    const tooltip = trigger.closest("openclaw-tooltip");
    if (tooltip) {
      tooltip.openOnClick = event.pointerType === "touch" || event.pointerType === "pen";
    }
  }

  private activateReaction(event: MouseEvent, emoji: string) {
    const tooltip = (event.currentTarget as HTMLButtonElement).closest("openclaw-tooltip");
    // The tooltip's capture handler reveals names on the first touch. A second
    // tap toggles the pill; the names bubble can open details without a write.
    if (tooltip?.openOnClick && tooltip.hasAttribute("open")) {
      return;
    }
    this.selectEmoji(emoji);
  }

  private renderPicker() {
    const names = this.query.trim()
      ? suggestEmoji(this.query.trim().toLowerCase().replace(/^:/u, ""))
      : QUICK_EMOJI;
    return html`<wa-popup active @wa-reposition=${this.focusPicker}>
      <section
        class="chat-reaction-popover"
        role="dialog"
        aria-label=${t("chat.reactions.add")}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            this.closePicker(true);
          }
        }}
      >
        <div class="chat-reaction-picker" role="group" aria-label=${t("chat.reactions.add")}>
          ${names.map((name) => {
            const emoji = emojiForShortcode(name);
            return emoji
              ? html`<button
                  type="button"
                  aria-label=${name}
                  aria-pressed=${String(this.reactions.some((reaction) => reaction.emoji === emoji && this.ownReaction(reaction)))}
                  ?disabled=${this.pending || !this.onReact}
                  @click=${() => this.selectEmoji(emoji)}
                >
                  ${emoji}
                </button>`
              : nothing;
          })}
        </div>
        ${names.length ? nothing : html`<p role="status">${t("chat.reactions.empty")}</p>`}
        <input
          class="chat-reaction-search"
          type="search"
          aria-label=${t("chat.reactions.search")}
          placeholder=${t("chat.reactions.search")}
          autocomplete="off"
          .value=${this.query}
          @input=${(event: InputEvent) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
        />
      </section>
    </wa-popup>`;
  }

  private renderPeople(reactions: readonly MessageReactionSummary[]) {
    const emoji = this.peopleEmoji;
    if (!emoji) {
      return nothing;
    }
    const people = reactions.find((reaction) => reaction.emoji === emoji)?.identities ?? [];
    return html`<openclaw-modal-dialog
      label=${t("chat.reactions.people")}
      @modal-cancel=${() => this.closeDialogs()}
    >
      <section class="chat-reaction-dialog">
        <header>
          <h2>${t("chat.reactions.people")}</h2>
          <button
            type="button"
            class="btn btn--icon"
            aria-label=${t("common.close")}
            @click=${() => this.closeDialogs()}
          >
            ${icons.x}
          </button>
        </header>
        <div class="chat-reaction-tabs" role="group" aria-label=${t("chat.reactions.people")}>
          ${reactions.map(
            (reaction) =>
              html`<button
                type="button"
                class="chat-reaction-chip"
                aria-label=${t("chat.reactions.toggle", { emoji: reaction.emoji, count: String(reaction.count) })}
                aria-pressed=${String(emoji === reaction.emoji)}
                @click=${() => {
                  this.peopleEmoji = reaction.emoji;
                }}
              >
                ${this.renderChipContent(reaction)}
              </button>`,
          )}
        </div>
        <ul class="chat-reaction-people">
          ${people.map((person) => html`<li><span class="chat-reaction-person-avatar" aria-hidden="true">${(person.label ?? person.id).slice(0, 1)}</span><span>${person.label ?? person.id}</span></li>`)}
        </ul>
        ${!people.length ? html`<p>${t("chat.reactions.none")}</p>` : nothing}
      </section>
    </openclaw-modal-dialog>`;
  }

  private observeLayout() {
    const strip = this.querySelector<HTMLElement>(".chat-reaction-strip") ?? undefined;
    const chips = this.querySelector<HTMLElement>(".chat-reaction-measure") ?? undefined;
    if (strip !== this.measuredStrip || chips !== this.measuredChips) {
      this.resizeObserver?.disconnect();
      this.measuredStrip = strip;
      this.measuredChips = chips;
      if (strip && chips && typeof ResizeObserver !== "undefined") {
        this.resizeObserver ??= new ResizeObserver(this.scheduleMeasure);
        this.resizeObserver.observe(strip);
        this.resizeObserver.observe(chips);
      }
    }
    this.scheduleMeasure();
  }

  private readonly scheduleMeasure = () => {
    if (!this.isConnected || this.measureFrame) {
      return;
    }
    // Measure after layout, never write sizes in ResizeObserver delivery. The
    // strip's CSS containment prevents its inventory from resizing the bubble.
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      const strip = this.measuredStrip;
      const measure = this.measuredChips;
      if (!this.isConnected || !strip || !measure || !strip.clientWidth) {
        return;
      }
      const widths = [...measure.querySelectorAll<HTMLElement>(".chat-reaction-chip")].map(
        (chip) => chip.getBoundingClientRect().width,
      );
      const total = this.reactions.length;
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
      const allWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, total - 1) * gap;
      let count = 0;
      if (total <= MAX_INLINE_REACTIONS && allWidth <= strip.clientWidth) {
        count = total;
      } else {
        // Reserve the widest possible +N label, so changing the visible prefix
        // cannot oscillate between two capacities at a rounding boundary.
        let used =
          measure.querySelector<HTMLElement>(".chat-reaction-more")?.getBoundingClientRect()
            .width ?? 0;
        for (const width of widths) {
          used += gap + width;
          if (used > strip.clientWidth) {
            break;
          }
          count += 1;
        }
      }
      const focused = this.ownerDocument.activeElement;
      const removingFocus =
        focused instanceof HTMLButtonElement &&
        this.contains(focused) &&
        ((count >= total &&
          (focused.classList.contains("chat-reaction-more") ||
            Boolean(this.querySelector(".chat-reaction-overflow")?.contains(focused)))) ||
          (strip.contains(focused) &&
            focused.classList.contains("chat-reaction-toggle") &&
            [...strip.querySelectorAll(".chat-reaction-toggle")].indexOf(focused) >= count));
      const emoji = removingFocus ? focused.dataset.emoji : undefined;
      const presentationGeneration = this.presentationGeneration;
      this.inlineCount = count;
      if (count >= total) {
        this.expanded = false;
      }
      if (removingFocus) {
        void this.updateComplete.then(() => {
          const active = this.ownerDocument.activeElement;
          if (
            !this.isConnected ||
            this.presentationGeneration !== presentationGeneration ||
            this.inlineCount !== count ||
            (active !== focused && active !== this.ownerDocument.body)
          ) {
            return;
          }
          const chips = [
            ...this.querySelectorAll<HTMLButtonElement>(
              ".chat-reaction-strip .chat-reaction-toggle",
            ),
          ];
          focusWithoutTooltip(
            chips.find((chip) => chip.dataset.emoji === emoji) ??
              this.querySelector<HTMLButtonElement>("button.chat-reaction-more") ??
              chips[0] ??
              this.querySelector<HTMLButtonElement>(".chat-reaction-actions button"),
          );
        });
      }
    });
  };

  private collapseReactions() {
    this.querySelector<HTMLButtonElement>(".chat-reaction-more")?.focus({ preventScroll: true });
    this.expanded = false;
  }

  private renderChipContent(reaction: MessageReactionSummary) {
    return html`<span class="chat-reaction-emoji" aria-hidden="true">${reaction.emoji}</span>
      ${reaction.count > 1 ? html`<span class="chat-reaction-count" aria-hidden="true">${reaction.count}</span>` : nothing}`;
  }

  private renderReaction(reaction: MessageReactionSummary, disabled: boolean, expanded = false) {
    return html`<openclaw-tooltip
      class="chat-reaction-tooltip"
      .delay=${400}
      .placement=${expanded ? "bottom" : "top"}
      .disabled=${this.pickerOpen || this.peopleEmoji !== null}
    >
      <button
        type="button"
        class="chat-reaction-chip chat-reaction-toggle"
        data-emoji=${reaction.emoji}
        aria-label=${t("chat.reactions.toggle", { emoji: reaction.emoji, count: String(reaction.count) })}
        aria-pressed=${String(this.ownReaction(reaction))}
        aria-disabled=${String(disabled)}
        @pointerdown=${this.prepareReactionPointer}
        @keydown=${(event: KeyboardEvent) => {
          const tooltip = (event.currentTarget as HTMLButtonElement).closest("openclaw-tooltip");
          if (tooltip) {
            tooltip.openOnClick = false;
          }
        }}
        @click=${(event: MouseEvent) => this.activateReaction(event, reaction.emoji)}
      >
        ${this.renderChipContent(reaction)}
      </button>
      <button
        slot="content"
        type="button"
        class="chat-reaction-details-link"
        aria-label=${t("chat.reactions.peopleForEmoji", { emoji: reaction.emoji })}
        aria-haspopup="dialog"
        @click=${(event: MouseEvent) => {
          this.peopleReturnTarget =
            (event.currentTarget as HTMLElement)
              .closest("openclaw-tooltip")
              ?.querySelector<HTMLButtonElement>(".chat-reaction-toggle") ?? null;
          // The native dialog also remembers its opening focus. Put that
          // on the stable pill, not the transient rich-tooltip link.
          this.peopleReturnTarget?.focus({ preventScroll: true });
          this.peopleEmoji = reaction.emoji;
        }}
      >
        ${this.names(reaction)}
      </button>
    </openclaw-tooltip>`;
  }

  override render() {
    const disabled = this.pending || !this.onReact;
    const hiddenCount = Math.max(0, this.reactions.length - this.inlineCount);
    return html`<div
        class="chat-reactions"
        aria-busy=${String(this.pending)}
        @keydown=${(event: KeyboardEvent) => {
          if (
            this.expanded &&
            event.key === "Escape" &&
            !event.isComposing &&
            !event.defaultPrevented
          ) {
            event.preventDefault();
            event.stopPropagation();
            this.collapseReactions();
          }
        }}
      >
        <div class="chat-reaction-strip">
          ${this.reactions.slice(0, this.inlineCount).map((reaction) => this.renderReaction(reaction, disabled))}
          ${
            hiddenCount
              ? html`<button
                  type="button"
                  class="chat-reaction-more"
                  aria-label=${t("chat.reactions.showMore", { count: String(hiddenCount) })}
                  aria-expanded=${String(this.expanded)}
                  @click=${() => {
                    this.expanded = !this.expanded;
                  }}
                >
                  +${hiddenCount}
                </button>`
              : nothing
          }
        </div>
        <div class="chat-reaction-actions">
          ${this.actions}
          ${
            this.onReact
              ? html`<openclaw-tooltip
                  content=${t("chat.reactions.add")}
                  .disabled=${this.pickerOpen}
                  ><button
                    type="button"
                    class="chat-reaction-add"
                    aria-label=${t("chat.reactions.add")}
                    aria-haspopup="dialog"
                    aria-expanded=${String(this.pickerOpen)}
                    ?disabled=${disabled}
                    @click=${() => this.togglePicker()}
                  >
                    <span class="chat-reaction-add-icon" aria-hidden="true"
                      >${ADD_REACTION_ICON}</span
                    >
                  </button></openclaw-tooltip
                >`
              : nothing
          }
        </div>
        ${
          this.expanded && hiddenCount
            ? html`<section class="chat-reaction-overflow" aria-label=${t("chat.reactions.all")}>
                <div class="chat-reaction-overflow-heading">
                  <span>${t("chat.reactions.all")}</span>
                  <button
                    type="button"
                    class="chat-reaction-collapse"
                    @click=${() => this.collapseReactions()}
                  >
                    ${t("chat.reactions.collapse")}
                  </button>
                </div>
                <div class="chat-reaction-overflow-chips">
                  ${this.reactions.map((reaction) => this.renderReaction(reaction, disabled, true))}
                </div>
              </section>`
            : nothing
        }
        <div class="chat-reaction-measure-clip" aria-hidden="true" inert>
          <div class="chat-reaction-measure">
            ${this.reactions.slice(0, MAX_INLINE_REACTIONS).map((reaction) => html`<span class="chat-reaction-chip">${this.renderChipContent(reaction)}</span>`)}
            <span class="chat-reaction-more">+${this.reactions.length}</span>
          </div>
        </div>
      </div>
      ${this.pickerOpen ? this.renderPicker() : nothing} ${this.renderPeople(this.reactions)}`;
  }
}

customElements.define("openclaw-chat-message-reactions", ChatMessageReactions);
