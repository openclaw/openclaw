import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";

/** A row's whole help, on demand. Same markup and classes as the field help in #191375. */
export function CloudWorkerFieldHelp(props: { id: string; label: string; help: string }) {
  const [mounted, setMounted] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  const label = () => t("configForm.sectionHelp", { section: props.label });
  return (
    <span class="config-field-help">
      <button
        ref={(node) => (button = node)}
        type="button"
        class="settings-section__help-button"
        aria-label={label()}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={mounted() ? props.id : undefined}
        onClick={() => {
          setMounted(true);
          setOpen(!open());
        }}
      >
        <span aria-hidden="true">
          <Icon name="circleQuestionMark" />
        </span>
      </button>
      <Show when={mounted()}>
        <Popover
          id={props.id}
          label={label()}
          class="settings-section__help-popover config-field-help__popover"
          anchor={button}
          placement="top-start"
          lazy="while-open"
          open={open()}
          onOpenChange={setOpen}
        >
          <div class="settings-section__help-panel">
            <p>{props.help}</p>
          </div>
        </Popover>
      </Show>
    </span>
  );
}
