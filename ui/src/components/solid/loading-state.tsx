import { t } from "../../lib/reactive/i18n.ts";
import { LoadingSkeleton } from "./loading-skeleton.tsx";

export function LoadingState(props: { route?: boolean; messagesOnly?: boolean } = {}) {
  return (
    <section
      class={[
        "lazy-view-state lazy-view-state--loading",
        { "lazy-view-state--route": props.route },
      ]}
      role="status"
      aria-live="polite"
      aria-busy={props.messagesOnly ? "true" : undefined}
      aria-label={t("common.loading")}
    >
      <LoadingSkeleton messagesOnly={props.messagesOnly} />
      {props.route ? <span class="connect-splash__status">{t("common.loading")}</span> : null}
    </section>
  );
}
