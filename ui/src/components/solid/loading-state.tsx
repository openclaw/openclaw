import { t } from "../../lib/reactive/i18n.ts";
import { LoadingSkeleton } from "./loading-skeleton.tsx";

export function LoadingState() {
  return (
    <section
      class="lazy-view-state lazy-view-state--loading"
      role="status"
      aria-live="polite"
      aria-label={t("common.loading")}
    >
      <LoadingSkeleton />
    </section>
  );
}
