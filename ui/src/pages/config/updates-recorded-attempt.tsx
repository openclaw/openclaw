import { action, createOptimistic, For, Show } from "solid-js";
import { projectUpdateRunHistory } from "../../../../src/infra/update-run-history-projection.ts";
import { isAcknowledgedAbandonedUpdateRun } from "../../../../src/infra/update-run-record.ts";
import {
  classifyUpdateOutcome,
  isReportableUpdateRun,
} from "../../../../src/shared/update-outcome-classification.ts";
import type { UpdateFailureReportNotice } from "../../app/overlays-types.ts";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { UpdateRunView } from "../../components/update-run-view.tsx";
import { registerUpdateActionsEnglish } from "../../i18n/locales/en-update-actions.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { UpdatesCommandPresentation, UpdatesViewProps } from "./updates-types.ts";

registerEnglishCatalog(registerUpdateActionsEnglish);

export function RecordedAttempt(
  props: UpdatesViewProps & { confirming: boolean; checking: boolean },
) {
  const [reporting, setReporting] = createOptimistic(false);
  const presentReport = action(function* (
    view: UpdatesCommandPresentation,
    pending: Promise<void>,
  ) {
    if (view.isCurrent()) {
      setReporting(true);
    }
    yield Promise.race([pending, view.retired]);
  });
  const reportFailure = async (attemptId: string) => {
    const view = props.captureCommandPresentation();
    const pending = props.onReportFailure(attemptId);
    await Promise.resolve();
    return presentReport(view, pending);
  };
  const run = () => props.update.updateRun;
  const serving = () =>
    props.connected ? { version: props.gatewayVersion, buildId: props.gatewayBuildId } : undefined;
  const failed = () => {
    const currentRun = run();
    return currentRun
      ? !projectUpdateRunHistory(currentRun, serving()) &&
          !isAcknowledgedAbandonedUpdateRun(currentRun) &&
          isReportableUpdateRun(currentRun)
      : !props.update.recordedUpdateAttempt ||
          classifyUpdateOutcome(props.update.recordedUpdateAttempt) !== "noop";
  };
  const canRetry = () =>
    !props.confirming &&
    props.canUpdate &&
    !props.updateBusy &&
    !props.update.updateStatusRefreshing;
  return (
    <Show when={run() || props.update.updateStatusBanner}>
      <SettingsSection title={t("updates.page.latestAttempt")}>
        <Show
          when={run()}
          fallback={
            <Show
              when={
                props.update.updateStatusBanner &&
                !props.updateBusy &&
                (props.update.updateStatusRefreshing || props.update.updateStatusCheckBanner)
              }
            >
              <SettingsRow
                title={t("updates.page.failedStep")}
                description={props.update.updateStatusBanner?.text}
              />
            </Show>
          }
        >
          <div class="settings-row settings-row--stacked">
            <UpdateRunView run={run()} connected={props.connected} serving={serving()} />
          </div>
        </Show>
        <Show when={failed() || props.update.updateStatusBanner?.source === "read"}>
          <SettingsRow
            title={t("updates.page.recoveryActions")}
            control={
              <div class="updates-status-control">
                <button
                  class="btn btn--sm"
                  type="button"
                  title={props.canCheckStatus ? "" : t("updates.adminRequired")}
                  disabled={
                    !props.canCheckStatus ||
                    props.updateBusy ||
                    props.update.updateStatusRefreshing ||
                    props.checking
                  }
                  onClick={() => void props.onCheckStatus()}
                >
                  {t("updates.page.checkStatus")}
                </button>
                <Show when={props.update.diagnosableUpdateFailureId}>
                  <button
                    class="btn btn--sm"
                    type="button"
                    title={props.canDiagnose ? "" : t("updates.adminRequired")}
                    disabled={
                      reporting() ||
                      !props.canDiagnose ||
                      props.updateBusy ||
                      props.update.updateStatusRefreshing ||
                      props.update.updateFailureReportBusy
                    }
                    onClick={() =>
                      props.onDiagnoseFailure(props.update.diagnosableUpdateFailureId!)
                    }
                  >
                    {t("updates.page.diagnoseFailure")}
                  </button>
                </Show>
                <Show when={failed()}>
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    title={canRetry() ? "" : t("updates.adminRequired")}
                    disabled={!canRetry()}
                    onClick={() => void props.onUpdateNow()}
                  >
                    {t("updates.page.retryUpdate")}
                  </button>
                </Show>
                <Show when={failed() && props.update.reportableUpdateFailureId}>
                  <button
                    class="btn btn--sm"
                    type="button"
                    title={props.canReport ? "" : t("updates.page.reportOwnerRequired")}
                    disabled={
                      reporting() ||
                      !props.canReport ||
                      props.updateBusy ||
                      props.update.updateStatusRefreshing ||
                      props.update.updateFailureReportBusy
                    }
                    onClick={() => void reportFailure(props.update.reportableUpdateFailureId!)}
                  >
                    {reporting() || props.update.updateFailureReportBusy
                      ? t("updates.page.reportSubmitting")
                      : t("updates.page.reportFailure")}
                  </button>
                </Show>
              </div>
            }
          />
          <Show when={failed() && run()?.target.installationMethod !== "ocm"}>
            <SettingsRow
              title={t("updates.page.cliFallback")}
              description={t("updates.triage.hostHint")}
              stacked
              control={
                <details class="updates-attempt-details">
                  <summary>{t("updates.page.showCliFallback")}</summary>
                  <pre>
                    <code>openclaw triage</code>
                  </pre>
                </details>
              }
            />
          </Show>
        </Show>
        <Show when={props.update.updateFailureReportNotice}>
          {(notice) => <UpdateFailureReportNoticeView notice={notice()} />}
        </Show>
      </SettingsSection>
    </Show>
  );
}

function UpdateFailureReportNoticeView(props: { notice: UpdateFailureReportNotice }) {
  const result = () => props.notice.result;
  const label = () =>
    t(
      {
        created: "updates.page.reportCreated",
        fallback: "updates.page.reportFallback",
        pending: "updates.page.reportPending",
        retryable: "updates.page.reportRetryable",
        duplicate: "updates.page.reportDuplicate",
        error: "updates.page.reportError",
      }[result().status],
    );
  const links = () => {
    const value = result();
    return [
      { href: "url" in value ? value.url : null, labelKey: "updates.page.openIssue" },
      {
        href: "fallbackUrl" in value ? value.fallbackUrl : null,
        labelKey: "updates.page.openPrefilledIssue",
      },
    ];
  };
  const message = () => {
    const value = result();
    return "message" in value ? value.message : null;
  };
  return (
    <SettingsRow
      title={t("updates.page.reportResult")}
      stacked
      control={
        <div class="updates-attempt-details" role="status">
          <div>{label()}</div>
          <For each={links()} keyed={(link) => link.labelKey}>
            {(link) => (
              <Show when={link().href}>
                {(href) => (
                  <div>
                    <a href={href()} target="_blank" rel="noreferrer">
                      {t(link().labelKey)}
                    </a>
                  </div>
                )}
              </Show>
            )}
          </For>
          <Show when={message()}>{(text) => <div>{text()}</div>}</Show>
        </div>
      }
    />
  );
}
