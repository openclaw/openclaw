import { createSignal } from "solid-js";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { generateUUID } from "../lib/uuid.ts";
import { EmojiSearchPanel } from "./emoji-search-panel.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import { StrokeIcon } from "./solid/stroke-icon.tsx";
import "../styles/agent-emoji-picker.css";

registerEnglishCatalog(registerSettingsEnglish);

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

type AgentEmojiPickerProps = {
  value?: string;
  disabled?: boolean;
  onSelect?: (emoji: string) => void;
};
export function AgentEmojiPicker(props: AgentEmojiPickerProps) {
  const [query, setQuery] = createSignal("");
  const id = `agent-emoji-trigger-${generateUUID()}`;
  let popover: PopoverHandle | undefined;
  let searchInput!: HTMLInputElement;
  return (
    <openclaw-agent-emoji-picker>
      <Popover
        id={`${id}-popover`}
        triggerId={id}
        triggerClass="agent-emoji-picker__trigger"
        trigger={
          <span class="agent-emoji-picker__icon" aria-hidden="true">
            <StrokeIcon>
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <path d="M9 9h.01M15 9h.01" />
            </StrokeIcon>
          </span>
        }
        class="agent-emoji-picker__popover"
        placement="bottom-end"
        disabled={props.disabled}
        label={t("agents.identity.chooseEmoji")}
        ref={(handle) => {
          popover = handle;
        }}
        onOpenChange={(open) => {
          if (open) {
            searchInput.focus({ preventScroll: true });
          } else {
            setQuery("");
          }
        }}
      >
        <EmojiSearchPanel
          query={query()}
          onQueryChange={setQuery}
          onSelect={(emoji) => {
            if (!props.disabled) {
              props.onSelect?.(emoji);
              popover?.overlay.request(false, "return");
            }
          }}
          isSelected={(emoji) => props.value === emoji}
          defaults={favorites}
          searchLabel={t("agents.identity.searchEmoji")}
          gridLabel={t("agents.identity.emoji")}
          emptyLabel={t("agents.identity.noEmojiMatches")}
          inputRef={(input) => {
            searchInput = input;
          }}
        />
      </Popover>
    </openclaw-agent-emoji-picker>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-emoji-picker": HTMLAttributes<HTMLElement>;
    }
  }
}
