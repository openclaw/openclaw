import { t } from "../../lib/reactive/i18n.ts";
import { LoadingSkeleton } from "./loading-skeleton.tsx";

export function LoadingState(
  props: { route?: boolean; messagesOnly?: boolean; composer?: boolean } = {},
) {
  return (
    <section
      class={[
        "lazy-view-state lazy-view-state--loading",
        { "lazy-view-state--route": props.route },
      ]}
      data-chat={props.composer ? "" : undefined}
      role="status"
      aria-live="polite"
      aria-busy={props.messagesOnly ? "true" : undefined}
      aria-label={t("common.loading")}
    >
      <LoadingSkeleton messagesOnly={props.messagesOnly} composer={props.composer} />
      {props.route ? (
        <span class="connect-splash__status" aria-hidden="true">
          {t("common.loading")}
        </span>
      ) : null}
    </section>
  );
}
