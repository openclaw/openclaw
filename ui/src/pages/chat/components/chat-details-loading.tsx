import { onSettled } from "solid-js";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatDetailsLoading(props: { onChange?: (loading: boolean) => void }) {
  onSettled(() => {
    props.onChange?.(true);
    return () => props.onChange?.(false);
  });
  return <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />;
}
