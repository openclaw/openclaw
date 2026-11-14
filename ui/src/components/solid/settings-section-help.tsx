import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";

/** The section's "?": longer explanations stay one click away instead of filling the page. */
export function SettingsSectionHelp(props: { id: string; section: string; children: JSX.Element }) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  let popover!: PopoverHandle;
  const label = () => t("common.helpFor", { section: props.section });
  return (
    <span class="settings-section__docs">
      <openclaw-tooltip prop:content={label()}>
        <button
          ref={setTrigger}
          type="button"
          class="settings-section__help-button"
          aria-label={label()}
          aria-controls={props.id}
          aria-haspopup="dialog"
          onClick={() => popover.overlay.request(!popover.overlay.open)}
        >
          <span aria-hidden="true">
            <Icon name="circleQuestionMark" />
          </span>
        </button>
      </openclaw-tooltip>
      <Show when={trigger()}>
        {(anchor) => (
          <Popover
            ref={(handle) => (popover = handle)}
            lazy="while-open"
            id={props.id}
            label={label()}
            class="settings-section__help-popover"
            anchor={anchor()}
            placement="bottom-end"
          >
            <div class="settings-section__help-panel">{props.children}</div>
          </Popover>
        )}
      </Show>
    </span>
  );
}
