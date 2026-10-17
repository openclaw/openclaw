import { dynamic } from "@solidjs/web";
import { For, createMemo } from "solid-js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { currentWorkIdentity } from "./current-work.ts";

registerEnglishCatalog(registerActivityEnglish);

type CurrentWorkProps = {
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
  globalScope: boolean;
  navigate: ApplicationContext["navigate"];
  connected: boolean;
  result?: SessionsListResult;
  loading: boolean;
  incomplete: boolean;
  error?: string;
  onRetry: () => void;
};

function CurrentSession(props: { owner: CurrentWorkProps; row: GatewaySessionRow }) {
  const face = createMemo(() => resolveSessionPreferredFace(props.row));
  const target = createMemo(() =>
    isSessionKeyAddressable(props.row.key, props.owner.globalScope)
      ? sessionNavigationTarget({
          face: face(),
          sessionKey: props.row.key,
          basePath: props.owner.basePath,
          fallbackAgentId: props.row.agentId ?? props.owner.fallbackAgentId,
          mainKey: props.owner.mainKey,
          row: props.row,
        })
      : null,
  );
  const CurrentRow = dynamic(() => (target() ? "a" : "div"));
  return (
    <CurrentRow
      class="activity-current-work__row"
      data-session-key={props.row.key}
      data-agent-id={props.row.agentId ?? undefined}
      href={target()?.href ?? undefined}
      onClick={
        target()
          ? (event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                props.owner.navigate(face(), target()!.options);
              }
            }
          : undefined
      }
    >
      <span class="activity-current-work__copy">
        <span class="activity-current-work__title">
          {resolveSessionDisplayName(props.row.key, props.row)}
        </span>
        <span class="activity-current-work__agent">
          {props.row.agentId
            ? t("activityFeed.agentLabel", { value: props.row.agentId })
            : props.row.key}
        </span>
      </span>
      <SettingsStatus
        kind="warn"
        label={
          props.row.status === "queued"
            ? t("activity.currentWork.queued")
            : t("activity.status.running")
        }
      />
    </CurrentRow>
  );
}

export function renderCurrentWork(props: CurrentWorkProps) {
  const rows = createMemo(() =>
    props.connected && !props.error ? (props.result?.sessions ?? []) : [],
  );
  const message = createMemo(() =>
    !props.connected
      ? t("activity.currentWork.disconnected")
      : props.error
        ? t("activity.currentWork.loadFailed")
        : !props.result || (rows().length === 0 && props.incomplete)
          ? t("activity.currentWork.loading")
          : rows().length === 0
            ? t("activity.currentWork.empty")
            : null,
  );
  return (
    <section
      class="activity-current-work"
      aria-label={t("activity.currentWork.title")}
      aria-busy={props.loading ? "true" : "false"}
    >
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("activity.currentWork.title")}</h2>
      </div>
      <div class="settings-group activity-current-work__rows">
        {message() ? (
          <div class="activity-current-work__feedback" role="status">
            <span>{message()}</span>
            {props.error ? (
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.loading}
                onClick={props.onRetry}
              >
                {t("common.retry")}
              </button>
            ) : undefined}
          </div>
        ) : (
          <For each={rows()} keyed={currentWorkIdentity}>
            {(row) => <CurrentSession owner={props} row={row()} />}
          </For>
        )}
        {props.result?.hasMore && !message() ? (
          <div class="activity-current-work__feedback">
            {t("activity.currentWork.limit", {
              count: String(rows().length),
              total: String(props.result.totalCount ?? rows().length),
            })}
          </div>
        ) : undefined}
      </div>
    </section>
  );
}
