import "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { strokeIcon } from "./icons-tools.ts";
import { syncPopoverLabel } from "./web-awesome-popover.ts";
import "../styles/agent-emoji-picker.css";

const favorites = [
  "🦞",
  "🚀",
  "✨",
  "🐬",
  "🦊",
  "🤖",
  "🌻",
  "🧠",
  "🎨",
  "📚",
  "🌍",
  "⚡",
  "🔥",
  "🌈",
  "🦉",
  "🐙",
  "🌙",
  "🎯",
  "💡",
  "🧪",
  "🎵",
  "💜",
  "🌟",
  "🐱",
];
const choices = Object.entries(emojiDefinitions).map(([name, emoji]) => ({ name, emoji }));
const favoriteChoices = favorites.map(
  (emoji) => choices.find((choice) => choice.emoji === emoji) ?? { name: emoji, emoji },
);

export class AgentEmojiPicker extends OpenClawLightDomElement {
  @property() value = "";
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) onSelect: (emoji: string) => void = () => undefined;
  @state() private query = "";
  private readonly triggerId = `agent-emoji-trigger-${crypto.randomUUID()}`;

  private select(emoji: string) {
    if (this.disabled || !emoji.trim()) {
      return;
    }
    this.onSelect(emoji.trim());
    void this.querySelector<WaPopover>("wa-popover")?.hide();
  }

  override render() {
    const query = this.query.trim().toLowerCase().replaceAll(" ", "_");
    const visible = query
      ? choices.filter(({ name, emoji }) => name.includes(query) || emoji === query).slice(0, 96)
      : favoriteChoices;
    const seen = new Set<string>();
    const unique = visible.filter(({ emoji }) => !seen.has(emoji) && seen.add(emoji));
    return html`
      <button
        id=${this.triggerId}
        type="button"
        class="agent-emoji-picker__trigger"
        aria-label=${t("agents.identity.chooseEmoji")}
        ?disabled=${this.disabled}
      >
        <span class="agent-emoji-picker__icon" aria-hidden="true"
          >${strokeIcon(svg`<circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" />`)}</span
        >
      </button>
      <wa-popover
        ${ref(syncPopoverLabel)}
        class="agent-emoji-picker__popover"
        for=${this.triggerId}
        placement="bottom-end"
        without-arrow
        @wa-hide=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.query = "";
          }
        }}
      >
        <div class="agent-emoji-picker__panel">
          <input
            class="agent-emoji-picker__search"
            type="search"
            autofocus
            aria-label=${t("agents.identity.searchEmoji")}
            placeholder=${t("agents.identity.searchEmoji")}
            .value=${this.query}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                this.query = event.currentTarget.value;
              }
            }}
          />
          <div
            class="agent-emoji-picker__grid"
            role="group"
            aria-label=${t("agents.identity.emoji")}
          >
            ${
              unique.length
                ? unique.map(
                    ({ emoji, name }) => html`<button
                      type="button"
                      class="agent-emoji-picker__choice"
                      aria-label=${name.replaceAll("_", " ")}
                      aria-pressed=${String(this.value === emoji)}
                      title=${name.replaceAll("_", " ")}
                      @click=${() => this.select(emoji)}
                    >
                      ${emoji}
                    </button>`,
                  )
                : html`<span class="agent-emoji-picker__empty"
                    >${t("agents.identity.noEmojiMatches")}</span
                  >`
            }
          </div>
        </div>
      </wa-popover>
    `;
  }
}

if (!customElements.get("openclaw-agent-emoji-picker")) {
  customElements.define("openclaw-agent-emoji-picker", AgentEmojiPicker);
}
