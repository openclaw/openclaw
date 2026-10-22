import { handleCopyButton } from "../../../components/copy-button-state.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuItem } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function desktopCopyPath(
  path: string,
  onButtonRef: (button: HTMLButtonElement) => void,
): MenuItem {
  const label = t("chat.sessionDiff.copyPath");
  return {
    id: "copy-path",
    label,
    closeOnSelect: false,
    render: (attributes) => (
      <div class="session-diff-menu__copy-action">
        <button
          {...attributes}
          ref={[attributes.ref, onButtonRef]}
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
      <code ref={createTextOverflow(() => props.value)} title={props.value}>
        {props.value}
      </code>
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
