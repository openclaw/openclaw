import { lazy } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { resolveCheckoutChip } from "./checkout-chip.ts";
import { SessionPicker } from "./picker.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

const CheckoutPickerContent = lazy(() => import("./checkout-picker-content.tsx"), {
  export: "CheckoutPickerContent",
});

export function CheckoutChip(props: {
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveCheckoutChip>;
  folderLabel: string;
}) {
  let popover!: PopoverHandle;
  let confirmPending = false;
  return (
    <SessionPicker
      lazy
      kind="checkout"
      label={`${t("newSession.checkout")}: ${props.state.label}`}
      value={props.state.label}
      icon={<Icon name="gitBranch" />}
      triggerAttributes={{
        title: `${t("newSession.checkout")}: ${props.state.label}`,
        "data-worktree": String(props.params.place.worktree),
      }}
      params={props.params}
      ref={(handle) => {
        popover = handle;
      }}
      onAfterHide={() => {
        if (confirmPending) {
          confirmPending = false;
          props.params.onFocusComposer();
        }
      }}
    >
      <CheckoutPickerContent
        params={props.params}
        folderLabel={props.folderLabel}
        onClose={() => popover.hide()}
        onConfirm={() => {
          if (popover.hide()) {
            confirmPending = true;
          }
        }}
      />
    </SessionPicker>
  );
}
