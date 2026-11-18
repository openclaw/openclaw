import { createMemo, createUniqueId, Show } from "solid-js";
import type { GatewayContextWindowOption } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerModelControlsEnglish();

export type ChatContextWindowControlParams = {
  options: readonly GatewayContextWindowOption[];
  selected: string;
  defaultId?: string;
  disabled: boolean;
  onSelect: (next: string, sessionKey: string) => Promise<void>;
};

export function ChatContextWindowControl(props: {
  contextWindow: ChatContextWindowControlParams;
  sessionKey: string;
}) {
  const id = createUniqueId();
  const selectedOption = createMemo(() =>
    props.contextWindow.options.find((option) => option.id === props.contextWindow.selected),
  );
  const items = createMemo(() =>
    props.contextWindow.options
      .toSorted((a, b) => a.contextWindow - b.contextWindow)
      .map((option) => ({
        id: option.id,
        label: option.label,
        type: "radio" as const,
        checked: option.id === props.contextWindow.selected,
        disabled: props.contextWindow.disabled,
      })),
  );
  return (
    <Show when={selectedOption()}>
      {(selected) => (
        <Menu
          id={id}
          label={t("chat.modelControls.contextWindowAria", { state: selected().label })}
          class="chat-controls__context-menu"
          triggerClass="chat-controls__context-trigger"
          panelClass="chat-controls__settings-popover chat-controls__context-options"
          placement="bottom-end"
          disabled={props.contextWindow.disabled}
          trigger={
            <>
              {selected().label}
              <Icon name="chevronDown" />
            </>
          }
          items={items()}
          onSelect={(item) => {
            if (!props.contextWindow.disabled && item.id !== props.contextWindow.selected) {
              void props.contextWindow.onSelect(item.id, props.sessionKey);
            }
          }}
        />
      )}
    </Show>
  );
}
