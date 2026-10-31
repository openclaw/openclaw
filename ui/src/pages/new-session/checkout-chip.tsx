import { createMemo, lazy } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SessionPicker } from "./picker.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

registerNewSessionSetupEnglish();

const CheckoutPickerContent = lazy(() => import("./checkout-picker-content.tsx"), {
  export: "CheckoutPickerContent",
});

export function CheckoutChip(props: {
  params: NewSessionPlaceControlsOptions;
  folderLabel: string;
}) {
  const label = createMemo(() => {
    const place = props.params.place;
    const destination = place.cloudProfileId ? "cloud" : place.remotePlacement ? "remote" : "local";
    const worktreeName = place.worktreeName.trim();
    if (place.worktree && !place.remoteRepository && worktreeName) {
      return t("newSession.checkoutWorktreeNamed", { name: worktreeName });
    }
    if (destination !== "cloud" && !place.remoteRepository && !place.worktree) {
      return (
        (place.repository.kind === "git" ? place.repository.headBranch : undefined) ||
        t("newSession.checkoutCurrent")
      );
    }
    const labels =
      destination === "cloud"
        ? (["newSession.checkoutCloud", "newSession.checkoutCloudFrom"] as const)
        : place.remoteRepository
          ? (["newSession.checkoutRepository", "newSession.checkoutRepositoryFrom"] as const)
          : (["newSession.checkoutWorktree", "newSession.checkoutWorktreeFrom"] as const);
    return place.baseRef ? t(labels[1], { branch: place.baseRef }) : t(labels[0]);
  });
  let popover!: PopoverHandle;
  let confirmPending = false;
  return (
    <SessionPicker
      lazy
      kind="checkout"
      label={`${t("newSession.checkout")}: ${label()}`}
      value={label()}
      icon={<Icon name="gitBranch" />}
      triggerAttributes={{
        title: `${t("newSession.checkout")}: ${label()}`,
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
