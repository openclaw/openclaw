import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/session-title-placeholder.css";

export function SessionTitlePlaceholder() {
  return (
    <span
      class="session-title-placeholder"
      role="status"
      aria-label={t("common.loading")}
      aria-busy="true"
    >
      <span class="skeleton" aria-hidden="true" />
    </span>
  );
}
