import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatDetailsLoading() {
  return <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />;
}

/** Shared compact geometry while code and then the first session facts load. */
export function ChatDetailsDesktopLoading() {
  return (
    <div
      class="chat-details-desktop-loading"
      role="status"
      aria-label={t("common.loading")}
      aria-busy="true"
    >
      <span class="skeleton" aria-hidden="true" />
      <span class="skeleton" aria-hidden="true" />
    </div>
  );
}
