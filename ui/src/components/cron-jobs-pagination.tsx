import { Show } from "solid-js";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { t } from "../lib/reactive/i18n.ts";
import "../styles/cron-jobs-pagination.css";

registerCronEnglish();

export function CronJobsPagination(props: {
  jobsShown: number;
  jobsTotal: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div class="cron-table__footer">
      <span class="muted">
        {t("cron.list.shownOf", {
          shown: String(props.jobsShown),
          total: String(Math.max(props.jobsTotal, props.jobsShown)),
        })}
      </span>
      <Show when={props.hasMore}>
        <button
          class="btn btn--sm cron-load-more"
          disabled={props.loading || props.loadingMore}
          onClick={() => props.onLoadMore()}
        >
          {props.loadingMore ? t("cron.list.loading") : t("cron.list.loadMore")}
        </button>
      </Show>
    </div>
  );
}
