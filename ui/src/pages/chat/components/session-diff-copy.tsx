import { handleCopyButton } from "../../../components/copy-button-state.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuItem } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

export function desktopCopyPath(path: string): MenuItem {
  const label = t("chat.sessionDiff.copyPath");
  return {
    id: "copy-path",
    label,
    closeOnSelect: false,
    render: (attributes) => (
      <div class="session-diff-menu__copy-action">
        <button
          {...attributes}
          type="button"
          class="oc-menu-item session-menu__item"
          onClick={(event) => {
            attributes.onClick?.(event);
            void handleCopyButton(event, path, label);
          }}
        >
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name="copy" />
          </span>
          <span class="session-menu__text" data-copy-label="">
            {label}
          </span>
        </button>
        <span class="sr-only" data-copy-feedback role="status" hidden />
      </div>
    ),
  };
}

export function CopyRow(props: {
  value: string;
  label: string;
  command?: boolean;
  initialFocus?: boolean;
  ref?: (element: HTMLButtonElement) => void;
}) {
  return (
    <div class={["session-diff-menu__copy-row", { "is-command": props.command }]}>
      <span class="session-diff-menu__copy-label">{props.label}</span>
      <code title={props.value}>{props.value}</code>
      <CopyButton
        ref={props.ref}
        text={props.value}
        idleLabel={props.label}
        buttonAttributes={{
          "data-form-control": "",
          "data-initial-focus": props.initialFocus ? "" : undefined,
        }}
      />
    </div>
  );
}
