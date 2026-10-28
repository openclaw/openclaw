// Curated Updates settings presentation. Authored policy stays in config;
// the Gateway schedule DTO owns runtime status.
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  refresh,
  Show,
} from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
  getUpdateGitComparison,
  isUpdateActionable,
} from "../../app/update-schedule-projection.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  RetryAction,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { UpdateGitRevisions } from "../../components/solid/update-git-revisions.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerUpdateActionsEnglish } from "../../i18n/locales/en-update-actions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { RecordedAttempt } from "./updates-recorded-attempt.tsx";
import { UpdatesStatus } from "./updates-status.tsx";
import {
  UPDATES_CHANNELS,
  type UpdatesChannel,
  type UpdatesViewProps,
  type UpdatesCommandPresentation,
} from "./updates-types.ts";

function DeviceUpdates(props: {
  capability: NativeDeviceSettingsCapability;
  captureCommandPresentation: () => UpdatesCommandPresentation;
}) {
  const native = createMemo(() => projectNativeDeviceSettings(props.capability));
  const snapshot = () => native().read();
  const updates = () => snapshot()?.updates;
  const [automatic, setAutomatic] = createOptimistic(() => updates()?.automatic ?? false);
  const [saving, setSaving] = createOptimistic(false);
  const [completed, setCompleted] = createSignal<Promise<void> | null>(null);
  const outcome = createMemo(async () => completed());
  const checked = createMemo(() => {
    if (!saving() && completed()) {
      latest(outcome);
    }
    return automatic();
  });
  let requestedValue = false;
  const presentChange = action(function* (
    view: UpdatesCommandPresentation,
    value: boolean,
    completion: Promise<void>,
  ) {
    if (view.isCurrent()) {
      setAutomatic(value);
      setSaving(true);
    }
    // The async receipt owns errors; this action owns only the saving affordance.
    yield completion.catch(() => {});
    if (view.isCurrent()) {
      yield refresh(automatic);
    }
  });
  const changeAutomatic = async (value: boolean) => {
    const view = props.captureCommandPresentation();
    requestedValue = value;
    const capability = props.capability;
    const pending = new Promise<void>((resolve, reject) => {
      void capability.set("updates.automatic", value, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const completion = Promise.race([pending, view.retired]);
    void setCompleted(() => completion);
    await Promise.resolve();
    return presentChange(view, value, completion);
  };
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
          <Errored
            fallback={(error, reset) => (
              <SettingsRow
                title={t("updates.device.automatic")}
                description={formatUiError(error())}
                control={
                  <button
                    class="btn btn--sm"
                    type="button"
                    onClick={() => {
                      reset();
                      void changeAutomatic(requestedValue);
                    }}
                  >
                    {t("common.retry")}
                  </button>
                }
              />
            )}
          >
            <Loading fallback={<SettingsValue value={t("common.saving")} />}>
              <SettingsToggleRow
                title={t("updates.device.automatic")}
                checked={checked()}
                saving={saving()}
                description={saving() ? t("common.saving") : undefined}
                onChange={(value) => void changeAutomatic(value)}
              />
            </Loading>
          </Errored>
          <SettingsRow
            title={t("updates.device.check")}
            control={
              <button
                class="btn primary"
                type="button"
                onClick={() => props.capability.checkForUpdates()}
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

registerEnglishCatalog(registerUpdateActionsEnglish);

registerEnglishCatalog(registerSettingsEnglish);

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

function BuildIdentifier(props: { title: string; value: string | null; short?: boolean }) {
  return (
    <SettingsRow
      title={props.title}
      control={
        <SettingsValue
          mono
          value={
            props.value ? (
              <code dir="ltr" title={props.value}>
                {props.short ? props.value.slice(0, 12) : props.value}
              </code>
            ) : (
              t("common.na")
            )
          }
        />
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
      <BuildIdentifier title={t("updates.page.gatewayVersion")} value={props.gatewayVersion} />
      <BuildIdentifier
        title={t("updates.page.controlUiCommit")}
        value={props.controlUiCommit}
        short
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
  const commits = () => {
    const update = props.update.updateAvailable;
    const comparison = getUpdateGitComparison(props.update.updateSchedule, update);
    return comparison &&
      comparison.commitsBehind === update?.commitsBehind &&
      comparison.currentSha === update?.currentSha &&
      comparison.upstreamSha === update?.upstreamSha
      ? (update?.commits ?? [])
      : [];
  };
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

function GatewayUpdates(props: UpdatesViewProps) {
  const [confirming, setConfirming] = createOptimistic(false);
  const [confirmation, setConfirmation] = createSignal<Promise<void> | null>(null);
  const confirmationOutcome = createMemo(async () => confirmation());
  const presentConfirmation = action(function* (
    view: UpdatesCommandPresentation,
    pending: Promise<void>,
  ) {
    if (view.isCurrent()) {
      setConfirming(true);
    }
    // The receipt below owns errors; this action only owns the pending affordance.
    yield pending.catch(() => {});
  });
  const updateNow = async () => {
    const view = props.captureCommandPresentation();
    const pending = Promise.race([props.onUpdateNow(), view.retired]);
    void setConfirmation(() => pending);
    await Promise.resolve();
    return presentConfirmation(view, pending);
  };
  // Seed only the first paint so checking does not suspend the surrounding settings.
  const completion = createMemo<boolean | null>(async () => (await props.statusRead) ?? false, {
    loadingValue: null,
  });
  const checking = () => Boolean(props.statusRead) && isPending(completion);
  const statusChecking = () => {
    if (!props.statusRead || props.updateBusy || props.update.updateRun?.status === "running") {
      return false;
    }
    return isPending(completion) || latest(completion) === null;
  };
  const [holdingCampaignId, setHoldingCampaignId] = createOptimistic<string | null>(null);
  const presentHold = action(function* (
    view: UpdatesCommandPresentation,
    pending: Promise<boolean>,
    campaignId: string,
  ) {
    if (view.isCurrent()) {
      setHoldingCampaignId(campaignId);
    }
    yield Promise.race([pending, view.retired]);
  });
  const holdUpdate = async (campaignId: string) => {
    const view = props.captureCommandPresentation();
    const pending = props.onHoldUpdate();
    await Promise.resolve();
    return presentHold(view, pending, campaignId);
  };
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
  const settings = () => {
    const configObject = props.configObject;
    const schedule = props.update.updateSchedule;
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
  };
  const channelOptions = (): Array<{ value: UpdatesChannel; label: string }> => [
    { value: "stable", label: t("updates.channel.stable") },
    { value: "beta", label: t("updates.channel.beta") },
    { value: "dev", label: t("updates.channel.dev") },
    ...(settings().extendedStable
      ? [{ value: "extended-stable" as const, label: t("updates.channel.extendedStable") }]
      : []),
  ];
  const checksDisabled = () => asConfigRecord(props.configObject.update)?.checkOnStart === false;
  const devPackageInstall = () =>
    settings().channel === "dev" && props.update.updateSchedule?.install?.kind === "package";
  const campaign = () => props.update.updateSchedule?.campaign;
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
    <>
      <Show when={!props.canAdmin}>
        <div class="callout warning" role="note">
          {t("updates.adminRequired")}
        </div>
      </Show>
      <BuildFacts {...props} />
      <RecordedAttempt
        {...props}
        confirming={confirming()}
        checking={checking()}
        onUpdateNow={updateNow}
      />
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
            settings().extendedStable
              ? t("updates.page.extendedStableAutomaticHint")
              : devPackageInstall()
                ? t("updates.page.devPackageAutomaticHint")
                : checksDisabled()
                  ? t("updates.page.checksDisabledAutomaticHint")
                  : t("updates.page.automaticUpdatesDescription")
          }
          checked={!settings().extendedStable && settings().autoEnabled}
          disabled={
            props.configBusy || checksDisabled() || settings().extendedStable || devPackageInstall()
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
                <Errored
                  fallback={(error, reset) => (
                    <span class="updates-status-check-failed">
                      <SettingsStatus kind="warn" label={formatUiError(error())} dot={false} />
                      <RetryAction
                        type="button"
                        onRetry={() => {
                          reset();
                          void props.onCheckStatus();
                        }}
                      />
                    </span>
                  )}
                >
                  <Loading
                    on={props.statusRead}
                    fallback={
                      <SettingsStatus kind="muted" label={t("updates.page.checking")} dot={false} />
                    }
                  >
                    <UpdatesStatus {...props} checking={statusChecking()} />
                  </Loading>
                </Errored>
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
                    checking() ||
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
                  disabled={
                    holdingCampaignId() === campaign()?.id ||
                    props.updateBusy ||
                    props.update.updateStatusRefreshing
                  }
                  onClick={() => void holdUpdate(campaign()!.id)}
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
        <Show when={run() && campaign() && run()!.origin.campaignId !== campaign()!.id}>
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
          description={t(
            formatUpdateTargetLabel(props.update.updateSchedule, props.update.updateAvailable)
              ? "updates.page.updateNowDescription"
              : "updates.page.noKnownUpdateDescription",
          )}
          control={
            <button
              type="button"
              class="btn"
              title={updateButtonTitle()}
              disabled={
                confirming() ||
                props.updateBusy ||
                props.update.updateStatusRefreshing ||
                !props.canUpdate ||
                checkRequired()
              }
              onClick={() => void updateNow()}
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
      <Errored
        fallback={(error, reset) => (
          <div class="callout danger" role="alert">
            {formatUiError(error())}
            <RetryAction
              type="button"
              onRetry={() => {
                reset();
                void updateNow();
              }}
            />
          </div>
        )}
      >
        <Loading>{latest(confirmationOutcome) ?? null}</Loading>
      </Errored>
    </>
  );
}

export function Updates(props: UpdatesViewProps) {
  return (
    <div id="config-section-update">
      <SettingsPage>
        <Show when={props.nativeDeviceSettings} keyed>
          {(capability) => (
            <DeviceUpdates
              capability={capability}
              captureCommandPresentation={props.captureCommandPresentation}
            />
          )}
        </Show>
        <Show when={props.commandScope ?? props} keyed>
          {(_scope) => <GatewayUpdates {...props} />}
        </Show>
      </SettingsPage>
    </div>
  );
}
