// Curated Updates settings presentation. The existing update config remains
// the source of authored policy; the Gateway schedule DTO owns runtime status.
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { isAcknowledgedAbandonedUpdateRun } from "../../../../src/infra/update-run-record.ts";
import {
  classifyUpdateOutcome,
  isReportableUpdateRun,
} from "../../../../src/shared/update-outcome.ts";
import "../../components/update-run-view.ts";
import type { UpdateScheduleState } from "../../api/types.ts";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type {
  ApplicationUpdateOverlaySnapshot,
  UpdateFailureReportNotice,
} from "../../app/overlays-types.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
  getUpdateGitComparison,
  isUpdateActionable,
} from "../../app/update-schedule-projection.ts";
import { renderExternalSupervisorGuidance } from "../../components/external-supervisor-guidance.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderUpdateGitRevisions } from "../../components/update-git-revisions.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";

registerSettingsEnglish();

const UPDATES_CHANNELS = ["stable", "beta", "dev", "extended-stable"] as const;
type UpdatesChannel = (typeof UPDATES_CHANNELS)[number];

type UpdatesViewProps = {
  update: ApplicationUpdateOverlaySnapshot;
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
  configObject: Record<string, unknown>;
  gatewayVersion: string | null;
  controlUiCommit: string | null;
  controlUiCommitAt: string | null;
  controlUiBuiltAt: string | null;
  connected: boolean;
  configBusy: boolean;
  canAdmin: boolean;
  canUpdate: boolean;
  canCheckStatus: boolean;
  canHoldUpdate: boolean;
  canReport: boolean;
  canDiagnose: boolean;
  updateBusy: boolean;
  nowMs?: number;
  onChannelChange: (channel: UpdatesChannel) => void;
  onUpdateChecksChange: (enabled: boolean) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  onUpdateNow: () => void;
  onHoldUpdate: () => Promise<boolean>;
  onCheckStatus: () => Promise<boolean>;
  onReportFailure: (attemptId: string) => Promise<void>;
  onDiagnoseFailure: (attemptId: string) => void;
};

function renderDeviceUpdates(capability: NativeDeviceSettingsCapability | null | undefined) {
  const snapshot = capability?.snapshot;
  const updates = snapshot?.updates;
  if (!capability || !snapshot || !updates) {
    return nothing;
  }
  return renderSettingsSection({ title: t(deviceSettingsGroupLabelKey(snapshot)) }, [
    renderSettingsRow({
      title: t("updates.device.version"),
      control: renderSettingsValue(
        t("updates.device.versionBuild", {
          version: snapshot.device.appVersion,
          build: snapshot.device.appBuild,
        }),
      ),
    }),
    updates.available
      ? html`${renderSettingsToggleRow({
          title: t("updates.device.automatic"),
          checked: updates.automatic,
          onChange: (value) => capability.set("updates.automatic", value),
        })}${renderSettingsRow({
          title: t("updates.device.check"),
          control: html`<button
            class="btn btn--sm"
            type="button"
            @click=${() => capability.checkForUpdates()}
          >
            ${t("updates.device.check")}
          </button>`,
        })}`
      : renderSettingsRow({
          title: t("updates.device.unavailable"),
          description: updates.unavailableReason,
        }),
  ]);
}

function renderRecordedAttempt(props: UpdatesViewProps) {
  const run = props.update.updateRun;
  if (!run && !props.update.updateStatusBanner) {
    return nothing;
  }
  const failed = run
    ? !isAcknowledgedAbandonedUpdateRun(run) && isReportableUpdateRun(run)
    : !props.update.recordedUpdateAttempt ||
      classifyUpdateOutcome(props.update.recordedUpdateAttempt) !== "noop";
  const readError = props.update.updateStatusBanner?.source === "read";
  const canRetry = props.canUpdate && !props.updateBusy && !props.update.updateStatusRefreshing;
  return renderSettingsSection({ title: t("updates.page.latestAttempt") }, [
    run
      ? html`<div class="settings-row settings-row--stacked">
          <openclaw-update-run-view
            .run=${run}
            .connected=${props.connected}
          ></openclaw-update-run-view>
        </div>`
      : props.update.updateStatusBanner &&
          !props.updateBusy &&
          (props.update.updateStatusRefreshing || props.update.updateStatusCheckBanner)
        ? renderSettingsRow({
            title: t("updates.page.failedStep"),
            description: props.update.updateStatusBanner.text,
          })
        : nothing,
    (run?.reason ?? props.update.recordedUpdateAttempt?.reason) ===
    "external-supervisor-update-required"
      ? renderExternalSupervisorGuidance(props.update.externalSupervisorGuidance)
      : nothing,
    ...(!failed && !readError
      ? []
      : [
          renderSettingsRow({
            title: t("updates.page.recoveryActions"),
            control: html`<div class="updates-status-control">
              <button
                class="btn btn--sm"
                type="button"
                title=${props.canCheckStatus ? "" : t("updates.adminRequired")}
                ?disabled=${!props.canCheckStatus || props.updateBusy || props.update.updateStatusRefreshing}
                @click=${() => void props.onCheckStatus()}
              >
                ${t("updates.page.checkStatus")}
              </button>
              ${
                props.update.diagnosableUpdateFailureId
                  ? html`<button
                      class="btn btn--sm"
                      type="button"
                      title=${props.canDiagnose ? "" : t("updates.adminRequired")}
                      ?disabled=${!props.canDiagnose || props.updateBusy || props.update.updateStatusRefreshing || props.update.updateFailureReportBusy}
                      @click=${() => props.onDiagnoseFailure(props.update.diagnosableUpdateFailureId!)}
                    >
                      ${t("updates.page.diagnoseFailure")}
                    </button>`
                  : nothing
              }
              ${
                failed
                  ? html`<button
                      class="btn btn--sm primary"
                      type="button"
                      title=${canRetry ? "" : t("updates.adminRequired")}
                      ?disabled=${!canRetry}
                      @click=${props.onUpdateNow}
                    >
                      ${t("updates.page.retryUpdate")}
                    </button>`
                  : nothing
              }
              ${
                failed && props.update.reportableUpdateFailureId
                  ? html`<button
                      class="btn btn--sm"
                      type="button"
                      title=${props.canReport ? "" : t("updates.page.reportOwnerRequired")}
                      ?disabled=${!props.canReport || props.updateBusy || props.update.updateStatusRefreshing || props.update.updateFailureReportBusy}
                      @click=${() => void props.onReportFailure(props.update.reportableUpdateFailureId!)}
                    >
                      ${
                        props.update.updateFailureReportBusy
                          ? t("updates.page.reportSubmitting")
                          : t("updates.page.reportFailure")
                      }
                    </button>`
                  : nothing
              }
            </div>`,
          }),
          failed
            ? renderSettingsRow({
                title: t("updates.page.cliFallback"),
                description: t("updates.triage.hostHint"),
                stacked: true,
                control: html`<details class="updates-attempt-details">
                  <summary>${t("updates.page.showCliFallback")}</summary>
                  <pre><code>openclaw triage</code></pre>
                </details>`,
              })
            : nothing,
        ]),
    props.update.updateFailureReportNotice
      ? renderUpdateFailureReportNotice(props.update.updateFailureReportNotice)
      : nothing,
  ]);
}

function renderUpdateFailureReportNotice(notice: UpdateFailureReportNotice) {
  const result = notice.result;
  const label =
    result.status === "created"
      ? t("updates.page.reportCreated")
      : result.status === "fallback"
        ? t("updates.page.reportFallback")
        : result.status === "pending"
          ? t("updates.page.reportPending")
          : result.status === "retryable"
            ? t("updates.page.reportRetryable")
            : result.status === "duplicate"
              ? t("updates.page.reportDuplicate")
              : t("updates.page.reportError");
  const url = "url" in result && result.url ? result.url : null;
  const fallbackUrl = "fallbackUrl" in result && result.fallbackUrl ? result.fallbackUrl : null;
  return renderSettingsRow({
    title: t("updates.page.reportResult"),
    stacked: true,
    control: html`<div class="updates-attempt-details" role="status">
      <div>${label}</div>
      ${
        url
          ? html`<div>
              <a href=${url} target="_blank" rel="noreferrer">${t("updates.page.openIssue")}</a>
            </div>`
          : nothing
      }
      ${
        fallbackUrl
          ? html`<div>
              <a href=${fallbackUrl} target="_blank" rel="noreferrer"
                >${t("updates.page.openPrefilledIssue")}</a
              >
            </div>`
          : nothing
      }
      ${"message" in result && result.message ? html`<div>${result.message}</div>` : nothing}
    </div>`,
  });
}

function readUpdatesSettings(
  configObject: Record<string, unknown>,
  schedule: UpdateScheduleState | null,
): { channel: UpdatesChannel; autoEnabled: boolean; extendedStable: boolean } {
  const update = asConfigRecord(configObject.update);
  const auto = asConfigRecord(update?.auto);
  // The saved (or drafted) channel owns policy; the Gateway schedule reports the
  // channel a configless install resolved to, since a direct
  // openclaw@extended-stable package install never writes update.channel.
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

function parseTimestampMs(value: string | null): number | null {
  return parseDateStringTimestampMs(value) ?? null;
}

function renderTimestamp(timestampMs: number, nowMs = Date.now()) {
  const relative = formatTimeAgo(Math.max(0, nowMs - timestampMs));
  return renderSettingsValue(
    html`<time datetime=${new Date(timestampMs).toISOString()} title=${relative}
      >${formatDateTimeMs(timestampMs, { dateStyle: "medium", timeStyle: "short" })}
      <span class="muted">· ${relative}</span></time
    >`,
  );
}

function renderBuildFacts(props: UpdatesViewProps) {
  const installKind = props.update.updateSchedule?.install?.kind;
  const git = props.update.updateSchedule?.install?.git;
  const builtAtMs = parseTimestampMs(props.controlUiBuiltAt);
  const commitAtMs = git?.commitAtMs ?? parseTimestampMs(props.controlUiCommitAt);
  return renderSettingsSection({ title: t("updates.page.buildTitle") }, [
    renderSettingsRow({
      title: t("updates.page.gatewayVersion"),
      control: renderSettingsValue(
        props.gatewayVersion
          ? html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`
          : t("common.na"),
        { mono: true },
      ),
    }),
    renderSettingsRow({
      title: t("updates.page.controlUiCommit"),
      control: renderSettingsValue(
        props.controlUiCommit
          ? html`<code dir="ltr" title=${props.controlUiCommit}
              >${props.controlUiCommit.slice(0, 12)}</code
            >`
          : t("common.na"),
        { mono: true },
      ),
    }),
    builtAtMs === null
      ? nothing
      : renderSettingsRow({
          title: t("updates.page.builtAt"),
          control: renderTimestamp(builtAtMs, props.nowMs),
        }),
    installKind === "git"
      ? renderSettingsRow({
          title: t("updates.page.installedAt"),
          control:
            git?.installedAtMs === undefined
              ? renderSettingsValue(t("updates.page.installedAtUnknown"))
              : renderTimestamp(git.installedAtMs, props.nowMs),
        })
      : nothing,
    commitAtMs === null
      ? nothing
      : renderSettingsRow({
          title: t("updates.page.lastCommitAt"),
          control: renderTimestamp(commitAtMs, props.nowMs),
        }),
    installKind
      ? renderSettingsRow({
          title: t("updates.page.installKind"),
          control: renderSettingsValue(t(`updates.installKind.${installKind}`)),
        })
      : nothing,
  ]);
}

function renderScheduleStatus(props: UpdatesViewProps): TemplateResult {
  const run = props.update.updateRun;
  const running = run?.status === "running";
  const campaign = props.update.updateSchedule?.campaign;
  const campaignLabel = formatUpdateCampaignLabel(props.update.updateSchedule, props.nowMs);
  const target = formatUpdateTargetLabel(props.update.updateSchedule, props.update.updateAvailable);
  let kind: Parameters<typeof renderSettingsStatus>[0]["kind"] = "muted";
  let label: string;
  if (running) {
    kind = "accent";
    label = t("updates.page.activePhase", { phase: t(`updates.run.phase.${run.phase}`) });
  } else if (props.update.updateStatusRefreshing && !props.updateBusy) {
    label = t("updates.page.checking");
  } else if (props.update.updateStatusCheckBanner && !props.updateBusy) {
    kind = "warn";
    label = props.update.updateStatusCheckBanner.text;
  } else if (campaignLabel) {
    kind = campaign?.state === "waiting-for-idle" ? "warn" : "accent";
    label = campaignLabel;
  } else if (props.update.updateStatusBanner) {
    kind =
      props.update.updateStatusBanner.tone === "danger"
        ? "danger"
        : props.update.updateStatusBanner.tone === "warn"
          ? "warn"
          : "accent";
    label = props.update.updateStatusBanner.text;
  } else if (props.update.updateSchedule?.install?.kind === "git") {
    const git = props.update.updateSchedule.install.git;
    if (!git) {
      label = t("updates.page.statusUnavailable");
    } else if (git.status === "current") {
      kind = "ok";
      label = t("updates.page.upToDate");
    } else if (git.status === "behind") {
      kind = "accent";
      const lag = t(
        git.commitsBehind === 1 ? "updates.target.commitBehind" : "updates.target.commitsBehind",
        { count: String(git.commitsBehind) },
      );
      label = t("updates.page.available", { target: lag });
    } else if (git.status === "ahead") {
      label = t(
        git.commitsAhead === 1 ? "updates.page.gitCommitAhead" : "updates.page.gitCommitsAhead",
        { count: String(git.commitsAhead) },
      );
    } else if (git.status === "diverged") {
      kind = "warn";
      label = t("updates.page.gitDiverged", {
        ahead: String(git.commitsAhead),
        behind: String(git.commitsBehind),
      });
    } else {
      kind = "warn";
      label =
        git.reason === "fetch-failed"
          ? t("updates.page.gitFetchFailed")
          : git.reason === "no-upstream"
            ? t("updates.page.gitNoUpstream")
            : t("updates.page.gitComparisonFailed");
    }
  } else if (target) {
    kind = "accent";
    label = t("updates.page.available", { target });
  } else if (props.update.updateSchedule?.install?.kind === "package") {
    kind = "ok";
    label = t("updates.page.upToDate");
  } else {
    label = t("updates.page.statusUnavailable");
  }
  const checkFailed =
    props.update.updateStatusCheckBanner &&
    !props.update.updateStatusRefreshing &&
    !props.updateBusy;
  const countdown =
    !running && (campaign?.state === "waiting-for-idle" || campaign?.state === "countdown");
  return html`<span
    class=${checkFailed ? "updates-status-check-failed" : nothing}
    role=${countdown ? "timer" : nothing}
    aria-live=${countdown ? "off" : nothing}
    >${renderSettingsStatus({ kind, label, dot: false })}</span
  >`;
}

function readGitCommits(props: UpdatesViewProps) {
  const update = props.update.updateAvailable;
  const comparison = getUpdateGitComparison(props.update.updateSchedule, update);
  const commitsMatch =
    comparison &&
    comparison.commitsBehind === update?.commitsBehind &&
    comparison.currentSha === update?.currentSha &&
    comparison.upstreamSha === update?.upstreamSha;
  return commitsMatch ? (update?.commits ?? []) : [];
}

function renderCommitList(props: UpdatesViewProps) {
  const commits = readGitCommits(props);
  if (commits.length === 0) {
    return nothing;
  }
  return renderSettingsRow({
    title: t("updates.page.commits"),
    stacked: true,
    control: html`
      <div class="updates-commit-list" role="list" aria-label=${t("updates.page.commits")}>
        ${commits.map(
          (commit) => html`
            <div class="updates-commit-list__row" role="listitem">
              <code title=${commit.sha}>${commit.sha}</code>
              <span>${commit.subject}</span>
            </div>
          `,
        )}
      </div>
    `,
  });
}

export function renderUpdates(props: UpdatesViewProps): TemplateResult {
  const run = props.update.updateRun?.status === "running" ? props.update.updateRun : null;
  const step = run?.steps.findLast(
    (entry) =>
      entry.status === "in_progress" &&
      entry.step !== run.phase &&
      !entry.step.startsWith("notice:"),
  );
  const runTarget = run?.target.sha ?? run?.target.version ?? run?.target.tag;
  const settings = readUpdatesSettings(props.configObject, props.update.updateSchedule);
  const channelOptions: Array<{ value: UpdatesChannel; label: string }> = [
    { value: "stable", label: t("updates.channel.stable") },
    { value: "beta", label: t("updates.channel.beta") },
    { value: "dev", label: t("updates.channel.dev") },
  ];
  if (settings.extendedStable) {
    channelOptions.push({
      value: "extended-stable",
      label: t("updates.channel.extendedStable"),
    });
  }
  const automaticUpdatesSupported = settings.channel !== "extended-stable";
  const checksDisabled = asConfigRecord(props.configObject.update)?.checkOnStart === false;
  const devPackageInstall =
    settings.channel === "dev" && props.update.updateSchedule?.install?.kind === "package";
  const campaign = props.update.updateSchedule?.campaign;
  const separateCampaign = run && campaign && run.origin.campaignId !== campaign.id;
  const holdActive =
    campaign?.holdUntilMs !== undefined && campaign.holdUntilMs > (props.nowMs ?? Date.now());
  const showHold = Boolean(
    !run &&
    campaign &&
    campaign.state !== "applying" &&
    props.canUpdate &&
    props.canHoldUpdate &&
    !holdActive &&
    props.update.heldUpdateCampaignId !== campaign.id,
  );
  const policyRows = [
    renderSettingsRow({
      title: t("updates.page.channel"),
      description: t("updates.page.channelDescription"),
      stacked: true,
      control: renderSettingsSegmented({
        value: settings.channel,
        options: channelOptions,
        ariaLabel: t("updates.page.channel"),
        disabled: props.configBusy,
        onChange: props.onChannelChange,
      }),
    }),
    renderSettingsToggleRow({
      title: t("updates.page.checkForUpdates"),
      description: t("updates.page.checkForUpdatesDescription"),
      checked: !checksDisabled,
      disabled: props.configBusy,
      onChange: props.onUpdateChecksChange,
    }),
    renderSettingsToggleRow({
      title: t("updates.page.automaticUpdates"),
      description: !automaticUpdatesSupported
        ? t("updates.page.extendedStableAutomaticHint")
        : devPackageInstall
          ? t("updates.page.devPackageAutomaticHint")
          : checksDisabled
            ? t("updates.page.checksDisabledAutomaticHint")
            : t("updates.page.automaticUpdatesDescription"),
      checked: automaticUpdatesSupported && settings.autoEnabled,
      disabled:
        props.configBusy || checksDisabled || !automaticUpdatesSupported || devPackageInstall,
      onChange: props.onAutomaticUpdatesChange,
    }),
  ];
  const checkRequired = Boolean(
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
  const updateButtonTitle =
    props.update.updateStatusRefreshing && !props.updateBusy
      ? t("updates.page.checking")
      : !props.canAdmin
        ? t("updates.adminRequired")
        : checkRequired
          ? t("updates.page.checkRequired")
          : "";
  return html`
    <div id="config-section-update">
      ${renderSettingsPage([
        renderDeviceUpdates(props.nativeDeviceSettings),
        !props.canAdmin
          ? html`<div class="callout warning" role="note">${t("updates.adminRequired")}</div>`
          : nothing,
        renderBuildFacts(props),
        renderRecordedAttempt(props),
        renderSettingsSection({ title: t("updates.page.policyTitle") }, policyRows),
        renderSettingsSection({ title: t("updates.page.statusTitle") }, [
          renderSettingsRow({
            title: t("updates.page.scheduleStatus"),
            description:
              run && props.update.updateStatusBanner?.source === "read"
                ? props.update.updateStatusBanner.text
                : undefined,
            control: html`
              <div class="updates-status-control">
                <div>
                  ${renderScheduleStatus(props)}
                  ${!run && !props.update.updateStatusRefreshing ? renderUpdateGitRevisions(props.update.updateSchedule, props.update.updateAvailable) : nothing}
                </div>
                ${
                  props.update.updateStatusCheckBanner
                    ? html`
                        <button
                          type="button"
                          class="btn btn--sm"
                          title=${props.update.updateStatusRefreshing ? t("updates.page.checking") : props.canCheckStatus ? "" : t("updates.adminRequired")}
                          ?disabled=${!props.canCheckStatus || props.update.updateStatusRefreshing || props.updateBusy}
                          @click=${() => void props.onCheckStatus()}
                        >
                          ${t("updates.page.checkForUpdates")}
                        </button>
                      `
                    : nothing
                }
                ${
                  showHold
                    ? html`
                        <button
                          type="button"
                          class="btn btn--sm"
                          ?disabled=${props.updateBusy || props.update.updateStatusRefreshing}
                          @click=${() => void props.onHoldUpdate()}
                        >
                          ${t("updates.holdOneHour")}
                        </button>
                      `
                    : nothing
                }
              </div>
            `,
          }),
          step
            ? renderSettingsRow({
                title: t("updates.page.currentStep"),
                control: renderSettingsValue(step.step),
              })
            : nothing,
          runTarget
            ? renderSettingsRow({
                title: t("updates.page.runTarget"),
                control: renderSettingsValue(
                  html`<code dir="ltr" title=${runTarget}
                    >${run?.target.sha ? runTarget.slice(0, 12) : runTarget}</code
                  >`,
                ),
              })
            : nothing,
          run
            ? renderSettingsRow({
                title: t("updates.page.lastProgress"),
                control: renderTimestamp(run.updatedAtMs, props.nowMs),
              })
            : nothing,
          separateCampaign
            ? renderSettingsRow({
                title: t("updates.page.scheduledUpdate"),
                control: html`<div>
                  <span role="timer" aria-live="off"
                    >${formatUpdateCampaignLabel(props.update.updateSchedule, props.nowMs)}</span
                  >
                  ${renderUpdateGitRevisions(props.update.updateSchedule, props.update.updateAvailable)}
                </div>`,
              })
            : nothing,
          !run ? renderCommitList(props) : nothing,
          renderSettingsRow({
            title: t("updates.page.updateNow"),
            description: t("updates.page.updateNowDescription"),
            control: html`
              <button
                type="button"
                class="btn primary"
                title=${updateButtonTitle}
                ?disabled=${props.updateBusy || props.update.updateStatusRefreshing || !props.canUpdate || checkRequired}
                @click=${props.onUpdateNow}
              >
                ${icons.download}
                ${props.updateBusy ? t("updates.page.updating") : t("updates.page.updateNow")}
              </button>
            `,
          }),
        ]),
        html`<p class="settings-page__hint">
          <a href="https://docs.openclaw.ai/install/update-troubleshooting" target="_blank"
            >${t("updates.page.troubleshoot")}</a
          >
        </p>`,
      ])}
    </div>
  `;
}
