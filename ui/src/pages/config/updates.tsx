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
  Show,
} from "solid-js";
import type { UpdateScheduleState } from "../../api/types.ts";
import {
  getUpdateGitComparison,
  isUpdateActionable,
} from "../../app/update-schedule-projection.ts";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { TabPanel, Tabs } from "../../components/solid/tabs.tsx";
import { UpdateGitRevisions } from "../../components/solid/update-git-revisions.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerUpdateActionsEnglish } from "../../i18n/locales/en-update-actions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import { DeviceUpdates } from "./updates-device.tsx";
import { RecordedAttempt } from "./updates-recorded-attempt.tsx";
import { UpdatesStatus } from "./updates-status.tsx";
import {
  UPDATES_CHANNELS,
  type UpdatesChannel,
  type UpdatesViewProps,
  type UpdatesCommandPresentation,
} from "./updates-types.ts";

registerEnglishCatalog(registerUpdateActionsEnglish);

registerEnglishCatalog(registerSettingsEnglish);

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
  const updateNow = async (existingRun?: NonNullable<UpdatesViewProps["update"]["updateRun"]>) => {
    const view = props.captureCommandPresentation();
    const pending = Promise.race([props.onUpdateNow(existingRun), view.retired]);
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
  const settings = () => readUpdatesSettings(props.configObject, props.update.updateSchedule);
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

      <p class="settings-page__hint">
        {t("updates.page.system")}: <strong>{t("updates.page.gateway")}</strong>
      </p>
      <section class="card stack" aria-label={t("updates.page.statusTitle")}>
        <h2 class="card-title">
          <Errored
            fallback={(error, reset) => (
              <span class="updates-status-check-failed">
                <SettingsStatus kind="warn" label={formatUiError(error())} dot={false} />
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => {
                    reset();
                    void props.onCheckStatus();
                  }}
                >
                  {t("common.retry")}
                </button>
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
        </h2>
        <Show when={run() && props.update.updateStatusBanner?.source === "read"}>
          <p class="card-sub">{props.update.updateStatusBanner?.text}</p>
        </Show>
        <div class="filters">
          <div>
            <div class="muted">{t("updates.page.installedVersion")}</div>
            <strong>{props.gatewayVersion ?? t("common.na")}</strong>
          </div>
          <Show
            when={
              props.update.updateSchedule?.target?.kind === "package"
                ? props.update.updateSchedule.target.version
                : props.update.updateAvailable?.latestVersion
            }
          >
            {(version) => (
              <>
                <span aria-hidden="true">→</span>
                <div>
                  <div class="muted">{t("updates.page.availableLabel")}</div>
                  <strong>{version()}</strong>
                </div>
              </>
            )}
          </Show>
        </div>
        <Show when={!run() && !props.update.updateStatusRefreshing}>
          <UpdateGitRevisions
            schedule={props.update.updateSchedule}
            updateAvailable={props.update.updateAvailable}
          />
        </Show>
        <p class="card-sub">{t("updates.confirm.impact")}</p>
        <div class="filters">
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
            {t("updates.page.checkStatus")}
          </button>
          <button
            type="button"
            class="btn primary"
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
            {props.updateBusy ? t("updates.page.updating") : t("updates.page.update")}
          </button>
        </div>
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
        </Show>{" "}
      </section>
      <SettingsSection title={t("updates.page.policyTitle")}>
        <SettingsSelectRow
          title={t("updates.page.channel")}
          description={t("updates.page.channelDescription")}
          value={settings().channel}
          options={channelOptions()}
          disabled={props.configBusy}
          onChange={(value) => {
            const channel = channelOptions().find((option) => option.value === value);
            if (channel) {
              props.onChannelChange(channel.value);
            }
          }}
        />
        <SettingsToggleRow
          title={t("updates.page.checkForUpdates")}
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
      <RecordedAttempt
        {...props}
        confirming={confirming()}
        checking={checking()}
        onUpdateNow={updateNow}
      />
      <Show when={props.update.updateAvailable?.commits?.length}>
        <details>
          <summary>{t("updates.page.commits")}</summary>
          <CommitList {...props} />
        </details>
      </Show>
      <details>
        <summary>{t("updates.page.technicalDetails")}</summary>
        <BuildFacts {...props} />
      </details>
      <p class="settings-page__hint">
        <a href="https://docs.openclaw.ai/install/update-troubleshooting" target="_blank">
          {t("updates.page.troubleshoot")}
        </a>
      </p>
      <Errored
        fallback={(error, reset) => (
          <div class="callout danger" role="alert">
            {formatUiError(error())}
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => {
                reset();
                void updateNow();
              }}
            >
              {t("common.retry")}
            </button>
          </div>
        )}
      >
        <Loading>{latest(confirmationOutcome) ?? null}</Loading>
      </Errored>
    </>
  );
}

export function Updates(props: UpdatesViewProps) {
  const [surface, setSurface] = createSignal<"gateway" | "apps">("gateway");
  const hasNative = () => Boolean(props.nativeDeviceSettings);
  const gatewayUpdateAvailable = () =>
    !props.update.updateStatusCheckBanner &&
    !props.update.updateStatusRefreshing &&
    isUpdateActionable(props.update.updateAvailable, props.update.updateSchedule, props.updateBusy);
  return (
    <div id="config-section-update">
      <SettingsPage>
        <Show when={hasNative()}>
          <Tabs
            class="settings-segmented settings-segmented--accent"
            ariaLabel={t("updates.page.systems")}
            active={surface()}
            activation="auto"
            onSelect={(value) => {
              if (value === "gateway" || value === "apps") {
                setSurface(value);
              }
            }}
            items={[
              {
                value: "gateway",
                label: (
                  <>
                    {t("updates.page.gateway")}
                    <Show when={gatewayUpdateAvailable()}>
                      <span
                        class="updates-tabs__available"
                        style={{ color: "var(--accent)" }}
                        role="img"
                        aria-label={t("updates.page.availableLabel")}
                      >
                        •
                      </span>
                    </Show>
                  </>
                ),
                className: [
                  "settings-segmented__btn",
                  { "settings-segmented__btn--active": surface() === "gateway" },
                ],
                id: "updates-gateway-tab",
                panelId: "updates-gateway-panel",
              },
              {
                value: "apps",
                label: t("updates.page.apps"),
                className: [
                  "settings-segmented__btn",
                  { "settings-segmented__btn--active": surface() === "apps" },
                ],
                id: "updates-apps-tab",
                panelId: "updates-apps-panel",
              },
            ]}
          />
        </Show>
        <Show
          when={hasNative()}
          fallback={
            <Show when={props.commandScope ?? props} keyed>
              {(_scope) => <GatewayUpdates {...props} />}
            </Show>
          }
        >
          <TabPanel
            id="updates-gateway-panel"
            tabId="updates-gateway-tab"
            active={surface() === "gateway"}
          >
            <Show when={props.commandScope ?? props} keyed>
              {(_scope) => <GatewayUpdates {...props} />}
            </Show>
          </TabPanel>
          <Show when={props.nativeDeviceSettings} keyed>
            {(capability) => (
              <TabPanel
                id="updates-apps-panel"
                tabId="updates-apps-tab"
                active={surface() === "apps"}
              >
                <DeviceUpdates
                  capability={capability}
                  captureCommandPresentation={props.captureCommandPresentation}
                />
              </TabPanel>
            )}
          </Show>
        </Show>
      </SettingsPage>
    </div>
  );
}
