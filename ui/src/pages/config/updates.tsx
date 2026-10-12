// Curated Updates settings presentation. Authored policy stays in config;
// the Gateway schedule DTO owns runtime status.
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import { isAcknowledgedAbandonedUpdateRun } from "../../../../src/infra/update-run-record.ts";
import {
  classifyUpdateOutcome,
  isReportableUpdateRun,
} from "../../../../src/shared/update-outcome.ts";
import "../../components/update-run-view.ts";
import type { UpdateScheduleState } from "../../api/types.ts";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { UpdateFailureReportNotice } from "../../app/overlays-types.ts";
import {
  formatUpdateCampaignLabel,
  getUpdateGitComparison,
  isUpdateActionable,
} from "../../app/update-schedule-projection.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { UpdateGitRevisions } from "../../components/solid/update-git-revisions.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { UpdatesStatus } from "./updates-status.tsx";
import { UPDATES_CHANNELS, type UpdatesChannel, type UpdatesViewProps } from "./updates-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

function DeviceUpdates(props: { capability?: NativeDeviceSettingsCapability | null }) {
  const native = createMemo(() => {
    const capability = props.capability;
    return capability ? projectNativeDeviceSettings(capability) : null;
  });
  const snapshot = () => native()?.read();
  const updates = () => snapshot()?.updates;
  return (
    <Show when={snapshot() && updates()}>
      <SettingsSection title={t(deviceSettingsGroupLabelKey(snapshot()!))}>
        <SettingsRow
          title={t("updates.device.version")}
          control={
            <SettingsValue
              value={t("updates.device.versionBuild", {
                version: snapshot()!.device.appVersion,
                build: snapshot()!.device.appBuild,
              })}
            />
          }
        />
        <Show
          when={updates()!.available}
          fallback={
            <SettingsRow
              title={t("updates.device.unavailable")}
              description={updates()!.unavailableReason}
            />
          }
        >
          <SettingsToggleRow
            title={t("updates.device.automatic")}
            checked={updates()!.automatic}
            onChange={(value) => props.capability!.set("updates.automatic", value)}
          />
          <SettingsRow
            title={t("updates.device.check")}
            control={
              <button
                class="btn btn--sm"
                type="button"
                onClick={() => props.capability!.checkForUpdates()}
              >
                {t("updates.device.check")}
              </button>
            }
          />
        </Show>
      </SettingsSection>
    </Show>
  );
}

function RecordedAttempt(props: UpdatesViewProps) {
  const run = () => props.update.updateRun;
  const failed = () => {
    const currentRun = run();
    return currentRun
      ? !isAcknowledgedAbandonedUpdateRun(currentRun) && isReportableUpdateRun(currentRun)
      : !props.update.recordedUpdateAttempt ||
          classifyUpdateOutcome(props.update.recordedUpdateAttempt) !== "noop";
  };
  const canRetry = () =>
    props.canUpdate && !props.updateBusy && !props.update.updateStatusRefreshing;
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
            <openclaw-update-run-view prop:run={run()} prop:connected={props.connected} />
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
                    !props.canCheckStatus || props.updateBusy || props.update.updateStatusRefreshing
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
                    onClick={props.onUpdateNow}
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
                      !props.canReport ||
                      props.updateBusy ||
                      props.update.updateStatusRefreshing ||
                      props.update.updateFailureReportBusy
                    }
                    onClick={() =>
                      void props.onReportFailure(props.update.reportableUpdateFailureId!)
                    }
                  >
                    {props.update.updateFailureReportBusy
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
  const url = () => {
    const value = result();
    return "url" in value && value.url ? value.url : null;
  };
  const fallbackUrl = () => {
    const value = result();
    return "fallbackUrl" in value && value.fallbackUrl ? value.fallbackUrl : null;
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
          <Show when={url()}>
            {(href) => (
              <div>
                <a href={href()} target="_blank" rel="noreferrer">
                  {t("updates.page.openIssue")}
                </a>
              </div>
            )}
          </Show>
          <Show when={fallbackUrl()}>
            {(href) => (
              <div>
                <a href={href()} target="_blank" rel="noreferrer">
                  {t("updates.page.openPrefilledIssue")}
                </a>
              </div>
            )}
          </Show>
          <Show when={message()}>{(text) => <div>{text()}</div>}</Show>
        </div>
      }
    />
  );
}

function readUpdatesSettings(
  configObject: Record<string, unknown>,
  schedule: UpdateScheduleState | null,
) {
  const update = asConfigRecord(configObject.update);
  const auto = asConfigRecord(update?.auto);
  // Authored policy wins; a configless package install resolves its channel at the Gateway.
  const channel =
    UPDATES_CHANNELS.find((candidate) => candidate === update?.channel) ??
    UPDATES_CHANNELS.find((candidate) => candidate === schedule?.channel) ??
    "stable";
  return {
    channel,
    autoEnabled:
      typeof auto?.enabled === "boolean" ? auto.enabled : (schedule?.autoEnabled ?? false),
    extendedStable: channel === "extended-stable",
  };
}

function Timestamp(props: { timestampMs: number; nowMs?: number }) {
  const relative = () =>
    formatTimeAgo(Math.max(0, (props.nowMs ?? Date.now()) - props.timestampMs));
  return (
    <SettingsValue
      value={
        <time datetime={new Date(props.timestampMs).toISOString()} title={relative()}>
          {formatDateTimeMs(props.timestampMs, { dateStyle: "medium", timeStyle: "short" })}{" "}
          <span class="muted">· {relative()}</span>
        </time>
      }
    />
  );
}

function BuildFacts(props: UpdatesViewProps) {
  const installKind = () => props.update.updateSchedule?.install?.kind;
  const git = () => props.update.updateSchedule?.install?.git;
  const builtAtMs = () => parseDateStringTimestampMs(props.controlUiBuiltAt) ?? null;
  const commitAtMs = () =>
    git()?.commitAtMs ?? parseDateStringTimestampMs(props.controlUiCommitAt) ?? null;
  return (
    <SettingsSection title={t("updates.page.buildTitle")}>
      <SettingsRow
        title={t("updates.page.gatewayVersion")}
        control={
          <SettingsValue
            mono
            value={
              props.gatewayVersion ? (
                <code dir="ltr" title={props.gatewayVersion}>
                  {props.gatewayVersion}
                </code>
              ) : (
                t("common.na")
              )
            }
          />
        }
      />
      <SettingsRow
        title={t("updates.page.controlUiCommit")}
        control={
          <SettingsValue
            mono
            value={
              props.controlUiCommit ? (
                <code dir="ltr" title={props.controlUiCommit}>
                  {props.controlUiCommit.slice(0, 12)}
                </code>
              ) : (
                t("common.na")
              )
            }
          />
        }
      />
      <Show when={builtAtMs() !== null}>
        <SettingsRow
          title={t("updates.page.builtAt")}
          control={<Timestamp timestampMs={builtAtMs()!} nowMs={props.nowMs} />}
        />
      </Show>
      <Show when={installKind() === "git"}>
        <SettingsRow
          title={t("updates.page.installedAt")}
          control={
            git()?.installedAtMs === undefined ? (
              <SettingsValue value={t("updates.page.installedAtUnknown")} />
            ) : (
              <Timestamp timestampMs={git()!.installedAtMs!} nowMs={props.nowMs} />
            )
          }
        />
      </Show>
      <Show when={commitAtMs() !== null}>
        <SettingsRow
          title={t("updates.page.lastCommitAt")}
          control={<Timestamp timestampMs={commitAtMs()!} nowMs={props.nowMs} />}
        />
      </Show>
      <Show when={installKind()}>
        {(kind) => (
          <SettingsRow
            title={t("updates.page.installKind")}
            control={<SettingsValue value={t(`updates.installKind.${kind()}`)} />}
          />
        )}
      </Show>
    </SettingsSection>
  );
}

function CommitList(props: UpdatesViewProps) {
  const commits = createMemo(() => {
    const update = props.update.updateAvailable;
    const comparison = getUpdateGitComparison(props.update.updateSchedule, update);
    return comparison &&
      comparison.commitsBehind === update?.commitsBehind &&
      comparison.currentSha === update?.currentSha &&
      comparison.upstreamSha === update?.upstreamSha
      ? (update?.commits ?? [])
      : [];
  });
  return (
    <Show when={commits().length > 0}>
      <SettingsRow
        title={t("updates.page.commits")}
        stacked
        control={
          <div class="updates-commit-list" role="list" aria-label={t("updates.page.commits")}>
            <For each={commits()} keyed={(commit) => commit.sha}>
              {(commit) => (
                <div class="updates-commit-list__row" role="listitem">
                  <code title={commit().sha}>{commit().sha}</code>
                  <span>{commit().subject}</span>
                </div>
              )}
            </For>
          </div>
        }
      />
    </Show>
  );
}

export function Updates(props: UpdatesViewProps) {
  const run = () => (props.update.updateRun?.status === "running" ? props.update.updateRun : null);
  const step = () => {
    const currentRun = run();
    return currentRun?.steps.findLast(
      (entry) =>
        entry.status === "in_progress" &&
        entry.step !== currentRun.phase &&
        !entry.step.startsWith("notice:"),
    );
  };
  const runTarget = () => run()?.target.sha ?? run()?.target.version ?? run()?.target.tag;
  const settings = createMemo(() =>
    readUpdatesSettings(props.configObject, props.update.updateSchedule),
  );
  const channelOptions = createMemo<Array<{ value: UpdatesChannel; label: string }>>(() => [
    { value: "stable", label: t("updates.channel.stable") },
    { value: "beta", label: t("updates.channel.beta") },
    { value: "dev", label: t("updates.channel.dev") },
    ...(settings().extendedStable
      ? [{ value: "extended-stable" as const, label: t("updates.channel.extendedStable") }]
      : []),
  ]);
  const automaticUpdatesSupported = () => settings().channel !== "extended-stable";
  const checksDisabled = () => asConfigRecord(props.configObject.update)?.checkOnStart === false;
  const devPackageInstall = () =>
    settings().channel === "dev" && props.update.updateSchedule?.install?.kind === "package";
  const campaign = () => props.update.updateSchedule?.campaign;
  const separateCampaign = () => run() && campaign() && run()!.origin.campaignId !== campaign()!.id;
  const campaignLabel = () => {
    getLocale();
    return formatUpdateCampaignLabel(props.update.updateSchedule, props.nowMs);
  };
  const showHold = () => {
    const currentCampaign = campaign();
    const holdActive =
      currentCampaign?.holdUntilMs !== undefined &&
      currentCampaign.holdUntilMs > (props.nowMs ?? Date.now());
    return Boolean(
      !run() &&
      currentCampaign &&
      currentCampaign.state !== "applying" &&
      props.canUpdate &&
      props.canHoldUpdate &&
      !holdActive &&
      props.update.heldUpdateCampaignId !== currentCampaign.id,
    );
  };
  const checkRequired = () =>
    Boolean(
      props.update.updateStatusCheckBanner &&
      !isUpdateActionable(
        props.update.updateAvailable,
        props.update.updateSchedule,
        props.updateBusy,
      ) &&
      props.update.updateSchedule?.target?.kind !== "package" &&
      props.update.updateSchedule?.install?.git?.status !== "behind" &&
      props.update.updateSchedule?.install?.git?.status !== "diverged",
    );
  const updateButtonTitle = () =>
    props.update.updateStatusRefreshing && !props.updateBusy
      ? t("updates.page.checking")
      : !props.canAdmin
        ? t("updates.adminRequired")
        : checkRequired()
          ? t("updates.page.checkRequired")
          : "";
  return (
    <div id="config-section-update">
      <SettingsPage>
        <DeviceUpdates capability={props.nativeDeviceSettings} />
        <Show when={!props.canAdmin}>
          <div class="callout warning" role="note">
            {t("updates.adminRequired")}
          </div>
        </Show>
        <BuildFacts {...props} />
        <RecordedAttempt {...props} />
        <SettingsSection title={t("updates.page.policyTitle")}>
          <SettingsRow
            title={t("updates.page.channel")}
            description={t("updates.page.channelDescription")}
            stacked
            control={
              <SettingsSegmented
                value={settings().channel}
                options={channelOptions()}
                ariaLabel={t("updates.page.channel")}
                disabled={props.configBusy}
                onChange={props.onChannelChange}
              />
            }
          />
          <SettingsToggleRow
            title={t("updates.page.checkForUpdates")}
            description={t("updates.page.checkForUpdatesDescription")}
            checked={!checksDisabled()}
            disabled={props.configBusy}
            onChange={props.onUpdateChecksChange}
          />
          <SettingsToggleRow
            title={t("updates.page.automaticUpdates")}
            description={
              !automaticUpdatesSupported()
                ? t("updates.page.extendedStableAutomaticHint")
                : devPackageInstall()
                  ? t("updates.page.devPackageAutomaticHint")
                  : checksDisabled()
                    ? t("updates.page.checksDisabledAutomaticHint")
                    : t("updates.page.automaticUpdatesDescription")
            }
            checked={automaticUpdatesSupported() && settings().autoEnabled}
            disabled={
              props.configBusy ||
              checksDisabled() ||
              !automaticUpdatesSupported() ||
              devPackageInstall()
            }
            onChange={props.onAutomaticUpdatesChange}
          />
        </SettingsSection>
        <SettingsSection title={t("updates.page.statusTitle")}>
          <SettingsRow
            title={t("updates.page.scheduleStatus")}
            description={
              run() && props.update.updateStatusBanner?.source === "read"
                ? props.update.updateStatusBanner.text
                : undefined
            }
            control={
              <div class="updates-status-control">
                <div>
                  <UpdatesStatus {...props} />
                  <Show when={!run() && !props.update.updateStatusRefreshing}>
                    <UpdateGitRevisions
                      schedule={props.update.updateSchedule}
                      updateAvailable={props.update.updateAvailable}
                    />
                  </Show>
                </div>
                <Show when={props.update.updateStatusCheckBanner}>
                  <button
                    type="button"
                    class="btn btn--sm"
                    title={
                      props.update.updateStatusRefreshing
                        ? t("updates.page.checking")
                        : props.canCheckStatus
                          ? ""
                          : t("updates.adminRequired")
                    }
                    disabled={
                      !props.canCheckStatus ||
                      props.update.updateStatusRefreshing ||
                      props.updateBusy
                    }
                    onClick={() => void props.onCheckStatus()}
                  >
                    {t("updates.page.checkForUpdates")}
                  </button>
                </Show>
                <Show when={showHold()}>
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={props.updateBusy || props.update.updateStatusRefreshing}
                    onClick={() => void props.onHoldUpdate()}
                  >
                    {t("updates.holdOneHour")}
                  </button>
                </Show>
              </div>
            }
          />
          <Show when={step()}>
            {(currentStep) => (
              <SettingsRow
                title={t("updates.page.currentStep")}
                control={<SettingsValue value={currentStep().step} />}
              />
            )}
          </Show>
          <Show when={runTarget()}>
            {(target) => (
              <SettingsRow
                title={t("updates.page.runTarget")}
                control={
                  <SettingsValue
                    value={
                      <code dir="ltr" title={target()}>
                        {run()?.target.sha ? target().slice(0, 12) : target()}
                      </code>
                    }
                  />
                }
              />
            )}
          </Show>
          <Show when={run()}>
            {(currentRun) => (
              <SettingsRow
                title={t("updates.page.lastProgress")}
                control={<Timestamp timestampMs={currentRun().updatedAtMs} nowMs={props.nowMs} />}
              />
            )}
          </Show>
          <Show when={separateCampaign()}>
            <SettingsRow
              title={t("updates.page.scheduledUpdate")}
              control={
                <div>
                  <span role="timer" aria-live="off">
                    {campaignLabel()}
                  </span>
                  <UpdateGitRevisions
                    schedule={props.update.updateSchedule}
                    updateAvailable={props.update.updateAvailable}
                  />
                </div>
              }
            />
          </Show>
          <Show when={!run()}>
            <CommitList {...props} />
          </Show>
          <SettingsRow
            title={t("updates.page.updateNow")}
            description={t("updates.page.updateNowDescription")}
            control={
              <button
                type="button"
                class="btn primary"
                title={updateButtonTitle()}
                disabled={
                  props.updateBusy ||
                  props.update.updateStatusRefreshing ||
                  !props.canUpdate ||
                  checkRequired()
                }
                onClick={props.onUpdateNow}
              >
                <Icon name="download" />
                {props.updateBusy ? t("updates.page.updating") : t("updates.page.updateNow")}
              </button>
            }
          />
        </SettingsSection>
        <p class="settings-page__hint">
          <a href="https://docs.openclaw.ai/install/update-troubleshooting" target="_blank">
            {t("updates.page.troubleshoot")}
          </a>
        </p>
      </SettingsPage>
    </div>
  );
}
