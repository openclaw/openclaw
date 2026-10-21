import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  onSettled,
} from "solid-js";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatByteSize, formatDateTimeMs } from "../../lib/format.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { createSettingsStatus } from "./settings-status.ts";
import { SESSION_STORAGE_SETTINGS_TARGET_ID } from "./settings-targets.ts";

registerEnglishCatalog(registerSettingsEnglish);

function storageSize(bytes: number) {
  return formatByteSize(bytes, {
    style: "iec",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? 0 : 1),
  });
}

function externalizedTranscripts(count: number): string {
  return count > 0 ? t("configView.sessionStorage.externalized", { count: String(count) }) : "";
}

type SettingsProps = {
  mutationDisabled?: boolean;
  buildEditor?: () => JSX.Element;
  advancedExpanded?: boolean;
};
export function SessionStorageSettings(props: SettingsProps) {
  const context = useApplication();
  const {
    client,
    pending,
    read: readStatus,
    scopeKey,
    requestKey,
    result,
    refresh: refreshStatus,
    capture,
    gatewayProjection,
    configProjection,
  } = createSettingsStatus<SessionsStorageStatusResult>(context, {
    method: "sessions.storage.status",
    access: hasOperatorAdminAccess,
    configHash: "appliedConfigHash",
    onConnectionChange: retireRequests,
    onStatus: observeMaintenance,
    onError: () => {
      stopPolling();
      setRunOutcome(null);
    },
  });
  const [ageDraft, setAgeDraft] = createSignal<string | null>(null);
  const [runError, setRunError] = createSignal<string | null>(null);
  const [runOutcome, setRunOutcome] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createOptimistic(false);
  // Admission and retirement are synchronous; Solid owns the visible submission state.
  let runOperation: AbortController | null = null;
  let followingRun = false;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  function stopPolling() {
    clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
  }
  function startPolling() {
    if (maintenanceTimer !== undefined) {
      return;
    }
    maintenanceTimer = setInterval(() => {
      if (!client()) {
        stopPolling();
      } else if (!pending()) {
        refreshStatus();
      }
    }, 2_000);
  }
  function retireRequests(identityChanged: boolean) {
    stopPolling();
    runOperation?.abort();
    runOperation = null;
    if (identityChanged) {
      followingRun = false;
      setAgeDraft(null);
      setRunError(null);
      setRunOutcome(null);
    }
  }
  onSettled(() => () => {
    stopPolling();
    runOperation?.abort();
  });
  function observeMaintenance(status: SessionsStorageStatusResult) {
    if (status.maintenance.running) {
      followingRun = true;
      startPolling();
      return;
    }
    stopPolling();
    if (followingRun) {
      setRunOutcome(
        status.maintenance.lastError
          ? null
          : [
              t("configView.sessionStorage.runCompleted", {
                count: String(status.maintenance.archivedTranscripts),
              }),
              externalizedTranscripts(status.maintenance.externalizedTranscripts),
            ]
              .filter(Boolean)
              .join(" "),
      );
      setRunError(null);
      followingRun = false;
    }
  }
  function disabled() {
    configProjection.read();
    gatewayProjection.read();
    const config = context.runtimeConfig;
    return (
      props.mutationDisabled ||
      submissionPending() ||
      runOperation !== null ||
      !client() ||
      !config.canSet ||
      !config.state.connected ||
      config.state.configLoading ||
      config.state.configSaving ||
      config.state.configApplying ||
      (config.state.configFormMode === "raw" && config.state.configFormDirty)
    );
  }
  function submissionPending() {
    gatewayProjection.read();
    return submitting() && runOperation !== null;
  }
  function storageConfig() {
    configProjection.read();
    gatewayProjection.read();
    const config = context.runtimeConfig.state;
    const session = asNullableRecord(
      asNullableRecord(config.configForm ?? config.configSnapshot?.config)?.session,
    );
    const coldStorage = asNullableRecord(asNullableRecord(session?.maintenance)?.coldStorage);
    return {
      enabled: coldStorage?.enabled === true,
      afterDays: typeof coldStorage?.afterDays === "number" ? coldStorage.afterDays : 30,
    };
  }
  function canRun() {
    configProjection.read();
    gatewayProjection.read();
    const config = context.runtimeConfig.state;
    const session = asNullableRecord(asNullableRecord(config.configSnapshot?.config)?.session);
    const coldStorage = asNullableRecord(asNullableRecord(session?.maintenance)?.coldStorage);
    const currentResult = result();
    return (
      !disabled() &&
      ageDraft() === null &&
      !config.configFormDirty &&
      !config.configNeedsApply &&
      typeof config.configSnapshot?.appliedConfigHash === "string" &&
      coldStorage?.enabled === true &&
      !pending() &&
      currentResult?.isCurrent() === true &&
      !currentResult.status.maintenance.running
    );
  }
  const ageValue = liveValue(() => ageDraft() ?? String(storageConfig().afterDays));
  const runNow = action(function* () {
    const currentClient = client();
    const ownsConnection = capture();
    if (!canRun() || !currentClient || !ownsConnection()) {
      return;
    }
    const operation = new AbortController();
    runOperation = operation;
    setSubmitting(true);
    setRunError(null);
    setRunOutcome(null);
    const isCurrent = () => runOperation === operation && ownsConnection();
    try {
      const response: SessionsStorageStatusResult =
        yield currentClient.request<SessionsStorageStatusResult>(
          "sessions.storage.run",
          {},
          { signal: operation.signal },
        );
      if (!isCurrent()) {
        return;
      }
      followingRun = true;
      setRunOutcome(
        response.maintenance.running ? t("configView.sessionStorage.runStarted") : null,
      );
      observeMaintenance(response);
      refreshStatus();
    } catch (error) {
      if (isCurrent()) {
        setRunError(formatUiError(error));
      }
    } finally {
      if (isCurrent()) {
        runOperation = null;
      }
    }
  });
  function setAge(event: Event) {
    // SAFETY: The native number input calls this synchronously from its own change binding.
    const input = event.currentTarget as HTMLInputElement;
    if (ageDraft() !== null && !disabled() && input.reportValidity()) {
      context.runtimeConfig.patchForm(
        ["session", "maintenance", "coldStorage", "afterDays"],
        input.valueAsNumber,
      );
      setAgeDraft(null);
    }
  }
  function StorageInventory(inventoryProps: { status: SessionsStorageStatusResult }) {
    const totals = createMemo(() =>
      inventoryProps.status.agents.reduce(
        (sum, agent) => ({
          transcripts: sum.transcripts + agent.hotTranscripts + agent.coldTranscripts,
          cold: sum.cold + agent.coldTranscripts,
          database: sum.database + agent.databaseBytes,
          wal: sum.wal + agent.walBytes,
          archives: sum.archives + agent.archiveBytes,
          embedded: sum.embedded + agent.embeddedArchiveBytes,
        }),
        { transcripts: 0, cold: 0, database: 0, wal: 0, archives: 0, embedded: 0 },
      ),
    );
    const externalized = () =>
      externalizedTranscripts(inventoryProps.status.maintenance.externalizedTranscripts);
    return (
      <>
        <SettingsRow
          title={t("configView.sessionStorage.transcripts")}
          description={t("configView.sessionStorage.transcriptCounts", {
            hot: String(totals().transcripts - totals().cold),
            cold: String(totals().cold),
          })}
          control={<SettingsValue value={String(totals().transcripts)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.database")}
          description={t("configView.sessionStorage.walSize", { size: storageSize(totals().wal) })}
          control={<SettingsValue value={storageSize(totals().database)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.archives")}
          control={<SettingsValue value={storageSize(totals().archives)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.embeddedArchives")}
          description={t("configView.sessionStorage.embeddedArchivesHint")}
          control={<SettingsValue value={storageSize(totals().embedded)} />}
        />
        {inventoryProps.status.agents.length > 1 ? (
          <details class="settings-row settings-row--stacked">
            <summary>{t("configView.sessionStorage.byAgent")}</summary>
            <For each={inventoryProps.status.agents}>
              {(agent) => (
                <SettingsRow
                  title={agent.agentId}
                  description={t("configView.sessionStorage.agentCounts", {
                    hot: String(agent.hotTranscripts),
                    cold: String(agent.coldTranscripts),
                    database: storageSize(agent.databaseBytes),
                    wal: storageSize(agent.walBytes),
                    archives: storageSize(agent.archiveBytes),
                    embedded: storageSize(agent.embeddedArchiveBytes),
                  })}
                />
              )}
            </For>
          </details>
        ) : undefined}
        <SettingsRow
          title={t("configView.sessionStorage.worker")}
          description={
            inventoryProps.status.maintenance.running
              ? t("configView.sessionStorage.runningProgress", {
                  archived: String(inventoryProps.status.maintenance.archivedTranscripts),
                  externalized: String(inventoryProps.status.maintenance.externalizedTranscripts),
                })
              : inventoryProps.status.maintenance.lastCompletedAt
                ? [
                    t("configView.sessionStorage.completed", {
                      time: formatDateTimeMs(inventoryProps.status.maintenance.lastCompletedAt),
                      count: String(inventoryProps.status.maintenance.archivedTranscripts),
                    }),
                    externalized(),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : t("configView.sessionStorage.notRun")
          }
          control={
            <SettingsStatus
              kind={
                inventoryProps.status.maintenance.lastError
                  ? "danger"
                  : inventoryProps.status.maintenance.running
                    ? "accent"
                    : "muted"
              }
              label={t(
                inventoryProps.status.maintenance.running
                  ? "configView.sessionStorage.running"
                  : inventoryProps.status.maintenance.lastError
                    ? "configView.sessionStorage.failed"
                    : "configView.sessionStorage.idle",
              )}
            />
          }
        />
        {inventoryProps.status.maintenance.lastError ? (
          <SettingsEmpty
            message={<span role="alert">{inventoryProps.status.maintenance.lastError}</span>}
          />
        ) : undefined}
      </>
    );
  }

  const status = () => result()?.status;
  return (
    <openclaw-session-storage-settings>
      <SettingsPage>
        <div class="settings-stack" id={SESSION_STORAGE_SETTINGS_TARGET_ID}>
          <SettingsSection
            title={t("configView.sessionStorage.title")}
            description={t("configView.sessionStorage.description")}
            actions={
              <button class="btn" disabled={!client() || pending()} onClick={() => refreshStatus()}>
                {t("common.refresh")}
              </button>
            }
          >
            <Errored
              fallback={(error) => (
                <SettingsEmpty
                  message={
                    pending() ? (
                      t("common.loading")
                    ) : (
                      <span role="alert">
                        {formatUiError(error())}
                        {t("configView.sessionStorage.refreshAfterError")}
                      </span>
                    )
                  }
                />
              )}
            >
              <Loading
                on={[scopeKey(), result() ? undefined : requestKey()]}
                fallback={<SettingsEmpty message={t("common.loading")} />}
              >
                <Show
                  when={readStatus()?.status}
                  keyed
                  fallback={
                    <SettingsEmpty
                      message={t(
                        client()
                          ? "common.loading"
                          : context.gateway.snapshot.phase === "connected"
                            ? "configView.sessionStorage.adminRequired"
                            : "configView.sessionStorage.disconnected",
                      )}
                    />
                  }
                >
                  {(currentStatus) => <StorageInventory status={currentStatus} />}
                </Show>
              </Loading>
            </Errored>
          </SettingsSection>
          <SettingsSection title={t("configView.sessionStorage.automatic")}>
            <>
              <SettingsToggleRow
                title={t("configView.sessionStorage.enabled")}
                description={t("configView.sessionStorage.enabledHint")}
                checked={storageConfig().enabled}
                disabled={disabled()}
                onChange={(enabled) => {
                  if (!disabled()) {
                    context.runtimeConfig.patchForm(
                      ["session", "maintenance", "coldStorage", "enabled"],
                      enabled,
                    );
                  }
                }}
              />
              <SettingsRow
                title={t("configView.sessionStorage.afterDays")}
                description={t("configView.sessionStorage.afterDaysHint")}
                control={
                  <input
                    type="number"
                    class="settings-input"
                    aria-label={t("configView.sessionStorage.afterDays")}
                    min="1"
                    max={Number.MAX_SAFE_INTEGER}
                    step="1"
                    required
                    disabled={disabled()}
                    ref={ageValue}
                    onInput={(event: Event) => {
                      // SAFETY: This handler is bound directly to the native number input.
                      setAgeDraft((event.currentTarget as HTMLInputElement).value);
                    }}
                    onChange={(event: Event) => setAge(event)}
                    onBlur={() => {
                      if (ageDraft() === String(storageConfig().afterDays)) {
                        setAgeDraft(null);
                      }
                    }}
                  />
                }
              />
              <SettingsRow
                title={t("configView.sessionStorage.runNow")}
                description={t("configView.sessionStorage.runHint")}
                control={
                  <button class="btn" disabled={!canRun()} onClick={() => void runNow()}>
                    {t(
                      submissionPending() || status()?.maintenance.running
                        ? "configView.sessionStorage.running"
                        : "configView.sessionStorage.runNow",
                    )}
                  </button>
                }
              />
              {submissionPending() ? undefined : runError() &&
                runError() !== status()?.maintenance.lastError ? (
                <SettingsEmpty message={<span role="alert">{runError()}</span>} />
              ) : runOutcome() ? (
                <SettingsEmpty message={<span role="status">{runOutcome()}</span>} />
              ) : undefined}
            </>
          </SettingsSection>
          <p class="settings-page__intro">{t("configView.sessionStorage.backupHint")}</p>
          <LearnMoreLink
            url={"https://docs.openclaw.ai/gateway/config-agents/sessions#cold-storage"}
          />
        </div>
      </SettingsPage>
      <ShellLayoutBoundary traits={{ settingsPage: true }}>
        <details class="settings-page" open={props.advancedExpanded}>
          <summary class="settings-section__heading">
            {t("configView.sessionStorage.advanced")}
          </summary>
          {props.buildEditor?.()}
        </details>
      </ShellLayoutBoundary>
    </openclaw-session-storage-settings>
  );
}
