import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { isPendingRouteTarget, isTarget } from "./catalog-target.ts";
import type { NewSessionRouteData } from "./location.ts";

export function CatalogBar(props: {
  data?: NewSessionRouteData;
  retrying: boolean;
  onRetry: () => void;
  groupPending?: boolean;
  agentSelect: JSX.Element;
  placeSelect: JSX.Element;
}) {
  return (
    <div class="new-session-page__triggers">
      {isTarget(props.data) ? (
        <span
          class="new-session-page__trigger new-session-page__runtime"
          title={
            props.data?.startTerminal && props.data.catalogLabel
              ? t("newSession.nativeTerminalHint")
              : t("newSession.catalogUnavailable")
          }
        >
          <span class="new-session-page__target-icon" aria-hidden="true">
            <Icon name="terminal" />
          </span>
          <span class="new-session-page__trigger-label">
            {props.data?.catalogLabel || props.data?.catalogId || ""}
          </span>
        </span>
      ) : (
        props.agentSelect
      )}
      {props.placeSelect}
      {isPendingRouteTarget(props.data) || props.groupPending === true ? (
        <span class="new-session-page__catalog-unavailable">
          {t("newSession.catalogUnavailable")}
          <button
            class="btn btn--sm"
            type="button"
            disabled={props.retrying}
            onClick={props.onRetry}
          >
            {props.retrying ? t("common.loading") : t("lazyView.retry")}
          </button>
        </span>
      ) : undefined}
    </div>
  );
}
