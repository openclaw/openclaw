import { action, createOptimistic, onSettled } from "solid-js";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

export function FileSystemOpenButton(props: { open: () => Promise<void> }) {
  const [pending, setPending] = createOptimistic(false);
  const retired = Promise.withResolvers<void>();
  let opening = false;
  let active = true;
  onSettled(() => () => {
    active = false;
    retired.resolve();
  });
  const present = action(function* (completion: Promise<void>) {
    setPending(true);
    yield Promise.race([completion, retired.promise]);
  });
  const open = () => {
    if (opening || !active) {
      return;
    }
    opening = true;
    const completion = props
      .open()
      .catch((error: unknown) => {
        if (active) {
          showToast({
            message: t("chat.detailPanel.openInSystemFailed", { error: formatUiError(error) }),
          });
        }
      })
      .finally(() => {
        opening = false;
      });
    void present(completion);
  };
  return (
    <button class="btn btn--sm" type="button" disabled={pending()} onClick={open}>
      {t(pending() ? "chat.detailPanel.openingInSystem" : "chat.detailPanel.openInSystem")}
    </button>
  );
}
