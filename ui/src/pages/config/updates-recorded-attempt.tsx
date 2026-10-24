import { action, createOptimistic, For, Show } from "solid-js";
import { isAcknowledgedAbandonedUpdateRun } from "../../../../src/infra/update-run-record.ts";
import {
  classifyUpdateOutcome,
  isReportableUpdateRun,
} from "../../../../src/shared/update-outcome-classification.ts";
import type { UpdateFailureReportNotice } from "../../app/overlays-types.ts";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerUpdateActionsEnglish } from "../../i18n/locales/en-update-actions.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
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
  const failed = () => {
    const currentRun = run();
    return currentRun
      ? !isAcknowledgedAbandonedUpdateRun(currentRun) && isReportableUpdateRun(currentRun)
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
          <SettingsRow
            title={t(
              `updates.page.attemptOutcome.${isAcknowledgedAbandonedUpdateRun(run()!) ? "reconciled" : run()!.status}`,
            )}
            description={formatDateTimeMs(run()!.updatedAtMs, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            control={
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.confirming}
                onClick={() => void props.onUpdateNow(run()!)}
              >
                {t("updates.page.viewResult")}
              </button>
            }
          />
        </Show>
        <Show when={!run() && (failed() || props.update.updateStatusBanner?.source === "read")}>
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
                <Show when={failed()}>
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    title={
                      !props.update.diagnosableUpdateFailureId
                        ? t("updates.page.failureActionUnavailable")
                        : props.canDiagnose
                          ? ""
                          : t("updates.adminRequired")
                    }
                    disabled={
                      !props.update.diagnosableUpdateFailureId ||
                      reporting() ||
                      !props.canDiagnose ||
                      props.updateBusy ||
                      props.update.updateStatusRefreshing ||
                      props.update.updateFailureReportBusy
                    }
                    onClick={() => {
                      const id = props.update.diagnosableUpdateFailureId;
                      if (id) {
                        props.onDiagnoseFailure(id);
                      }
                    }}
                  >
                    {t("updates.page.diagnoseFailure")}
                  </button>
                  <button
                    class="btn btn--sm"
                    type="button"
                    title={canRetry() ? "" : t("updates.adminRequired")}
                    disabled={!failed() || !canRetry()}
                    onClick={() => void props.onUpdateNow()}
                  >
                    {t("updates.page.retryUpdate")}
                  </button>
                  <button
                    class="btn btn--sm"
                    type="button"
                    title={
                      !props.update.reportableUpdateFailureId
                        ? t("updates.page.failureActionUnavailable")
                        : props.canReport
                          ? ""
                          : t("updates.page.reportOwnerRequired")
                    }
                    disabled={
                      !failed() ||
                      !props.update.reportableUpdateFailureId ||
                      reporting() ||
                      !props.canReport ||
                      props.updateBusy ||
                      props.update.updateStatusRefreshing ||
                      props.update.updateFailureReportBusy
                    }
                    onClick={() => {
                      const id = props.update.reportableUpdateFailureId;
                      if (id) {
                        void reportFailure(id);
                      }
                    }}
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
