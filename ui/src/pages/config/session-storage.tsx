import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
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
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
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
  mutationDisabled: boolean;
  buildEditor: (() => JSX.Element) | undefined;
  advancedExpanded: boolean;
};
export function SessionStorageSettingsContent(props: SettingsProps) {
  const context = useApplication();
  const gatewayProjection = projectGateway(context.gateway);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const gateway = createGatewayConnectionLifecycle(context.gateway.snapshot);
  let disposed = false;
  let request: AbortController | undefined;
  const [requestStatus, setRequestStatus] = createSignal<"idle" | "pending" | "complete" | "error">(
    untrack(client) ? "pending" : "idle",
  );
  const [requestError, setRequestError] = createSignal<unknown>();
  const [result, setResult] = createSignal<
    { status: SessionsStorageStatusResult; isCurrent: () => boolean } | undefined
  >();
  const [refreshRevision, setRefreshRevision] = createSignal(0);
  function refreshStatus() {
    setRefreshRevision((value) => value + 1);
  }
  function client() {
    gatewayProjection.read();
    const snapshot = context.gateway.snapshot;
    return !disposed &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  }
  const [ageDraft, setAgeDraft] = createSignal<string | null>(null);
  const [runError, setRunError] = createSignal<string | null>(null);
  const [runOutcome, setRunOutcome] = createSignal<string | null>(null);
  const [runOperation, setRunOperation] = createSignal<object | null>(null);
  let previousHello = context.gateway.snapshot.hello;
  let previousAuth = previousHello?.auth;
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
      } else if (requestStatus() !== "pending") {
        refreshStatus();
      }
    }, 2_000);
  }
  function retireRequests() {
    request?.abort();
    stopPolling();
    followingRun = false;
    setAgeDraft(null);
    setRunOperation(null);
    setRunError(null);
    setRunOutcome(null);
  }
  function synchronizeConnection() {
    const snapshot = context.gateway.snapshot;
    const transition = gateway.transition(snapshot);
    const identityChanged =
      previousHello !== snapshot.hello || previousAuth !== snapshot.hello?.auth;
    if (identityChanged) {
      gateway.invalidate();
    }
    previousHello = snapshot.hello;
    previousAuth = snapshot.hello?.auth;
    if (transition || identityChanged) {
      retireRequests();
      refreshStatus();
    }
  }
  const unsubscribeGateway = gatewayProjection.subscribe(synchronizeConnection);
  onCleanup(unsubscribeGateway);
  const requestKey = createMemo(
    () => {
      const snapshot = gatewayProjection.read().snapshot;
      return [
        client(),
        snapshot.phase,
        snapshot.hello,
        snapshot.hello?.auth,
        configProjection.read().state.configSnapshot?.appliedConfigHash,
        refreshRevision(),
      ] as const;
    },
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  createEffect(requestKey, ([currentClient, , hello, auth, hash], previous) => {
    request?.abort();
    if (!currentClient) {
      if (previous) {
        setRequestStatus("idle");
      }
      return undefined;
    }
    const controller = new AbortController();
    request = controller;
    const scope = gateway.capture();
    const currentGateway = context.gateway;
    const isConnectionCurrent = () =>
      client() === currentClient &&
      scope !== null &&
      gateway.isCurrent(scope) &&
      context.gateway === currentGateway &&
      currentGateway.snapshot.hello === hello &&
      hello?.auth === auth &&
      context.runtimeConfig.state.configSnapshot?.appliedConfigHash === hash;
    const isCurrent = () =>
      !controller.signal.aborted && request === controller && isConnectionCurrent();
    if (previous) {
      setRequestStatus("pending");
    }
    void currentClient
      .request<SessionsStorageStatusResult>(
        "sessions.storage.status",
        {},
        { signal: controller.signal },
      )
      .then(
        (status) => {
          if (!isCurrent()) {
            return;
          }
          setResult({ status, isCurrent: isConnectionCurrent });
          setRequestStatus("complete");
          observeMaintenance(status);
        },
        (error: unknown) => {
          if (!isCurrent()) {
            return;
          }
          setRequestError(error);
          setRequestStatus("error");
          stopPolling();
          setRunOutcome(null);
        },
      );
    return () => controller.abort();
  });
  onCleanup(() => {
    disposed = true;
    retireRequests();
    gateway.dispose();
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
      runOperation() !== null ||
      !client() ||
      !config.canSet ||
      !config.state.connected ||
      config.state.configLoading ||
      config.state.configSaving ||
      config.state.configApplying ||
      (config.state.configFormMode === "raw" && config.state.configFormDirty)
    );
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
      requestStatus() === "complete" &&
      currentResult?.isCurrent() === true &&
      !currentResult.status.maintenance.running
    );
  }
  let ageInput: HTMLInputElement | undefined;
  createEffect(
    () => ageDraft() ?? String(storageConfig().afterDays),
    (value) => {
      // Preserve the native number draft when an owner publication leaves it unchanged.
      if (ageInput && ageInput.value !== value) {
        ageInput.value = value;
      }
    },
  );
  async function runNow() {
    const currentClient = client();
    const scope = gateway.capture();
    if (!canRun() || !currentClient || !scope) {
      return;
    }
    const operation = {};
    const currentGateway = context.gateway;
    const hello = currentGateway.snapshot.hello;
    const auth = hello?.auth;
    setRunOperation(operation);
    setRunError(null);
    setRunOutcome(null);
    const isCurrent = () =>
      runOperation() === operation &&
      client() === currentClient &&
      gateway.isCurrent(scope) &&
      context.gateway === currentGateway &&
      currentGateway.snapshot.hello === hello &&
      hello?.auth === auth;
    try {
      const response = await currentClient.request<SessionsStorageStatusResult>(
        "sessions.storage.run",
        {},
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
        setRunOperation(null);
      }
    }
  }
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
  function renderInventory(status: SessionsStorageStatusResult) {
    const totals = status.agents.reduce(
      (sum, agent) => ({
        transcripts: sum.transcripts + agent.hotTranscripts + agent.coldTranscripts,
        cold: sum.cold + agent.coldTranscripts,
        database: sum.database + agent.databaseBytes,
        wal: sum.wal + agent.walBytes,
        archives: sum.archives + agent.archiveBytes,
        embedded: sum.embedded + agent.embeddedArchiveBytes,
      }),
      { transcripts: 0, cold: 0, database: 0, wal: 0, archives: 0, embedded: 0 },
    );
    const externalized = externalizedTranscripts(status.maintenance.externalizedTranscripts);
    return (
      <>
        <SettingsRow
          title={t("configView.sessionStorage.transcripts")}
          description={t("configView.sessionStorage.transcriptCounts", {
            hot: String(totals.transcripts - totals.cold),
            cold: String(totals.cold),
          })}
          control={<SettingsValue value={String(totals.transcripts)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.database")}
          description={t("configView.sessionStorage.walSize", { size: storageSize(totals.wal) })}
          control={<SettingsValue value={storageSize(totals.database)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.archives")}
          control={<SettingsValue value={storageSize(totals.archives)} />}
        />
        <SettingsRow
          title={t("configView.sessionStorage.embeddedArchives")}
          description={t("configView.sessionStorage.embeddedArchivesHint")}
          control={<SettingsValue value={storageSize(totals.embedded)} />}
        />
        {status.agents.length > 1 ? (
          <details class="settings-row settings-row--stacked">
            <summary>{t("configView.sessionStorage.byAgent")}</summary>
            <For each={status.agents}>
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
            status.maintenance.running
              ? t("configView.sessionStorage.runningProgress", {
                  archived: String(status.maintenance.archivedTranscripts),
                  externalized: String(status.maintenance.externalizedTranscripts),
                })
              : status.maintenance.lastCompletedAt
                ? [
                    t("configView.sessionStorage.completed", {
                      time: formatDateTimeMs(status.maintenance.lastCompletedAt),
                      count: String(status.maintenance.archivedTranscripts),
                    }),
                    externalized,
                  ]
                    .filter(Boolean)
                    .join(" ")
                : t("configView.sessionStorage.notRun")
          }
          control={
            <SettingsStatus
              kind={
                status.maintenance.lastError
                  ? "danger"
                  : status.maintenance.running
                    ? "accent"
                    : "muted"
              }
              label={t(
                status.maintenance.running
                  ? "configView.sessionStorage.running"
                  : status.maintenance.lastError
                    ? "configView.sessionStorage.failed"
                    : "configView.sessionStorage.idle",
              )}
            />
          }
        />
        {status.maintenance.lastError ? (
          <SettingsEmpty message={<span role="alert">{status.maintenance.lastError}</span>} />
        ) : undefined}
      </>
    );
  }

  const status = () => {
    const currentResult = result();
    return requestStatus() !== "error" && currentResult?.isCurrent() ? currentResult.status : null;
  };
  return (
    <>
      <SettingsPage>
        <div class="settings-stack" id={SESSION_STORAGE_SETTINGS_TARGET_ID}>
          <SettingsSection
            title={t("configView.sessionStorage.title")}
            description={t("configView.sessionStorage.description")}
            actions={
              <button
                class="btn"
                disabled={!client() || requestStatus() === "pending"}
                onClick={() => refreshStatus()}
              >
                {t("common.refresh")}
              </button>
            }
          >
            <Show
              when={status()}
              keyed
              fallback={
                <SettingsEmpty
                  message={
                    requestStatus() === "error" ? (
                      <span role="alert">
                        {formatUiError(requestError())}
                        {t("configView.sessionStorage.refreshAfterError")}
                      </span>
                    ) : (
                      t(
                        client()
                          ? "common.loading"
                          : context.gateway.snapshot.phase === "connected"
                            ? "configView.sessionStorage.adminRequired"
                            : "configView.sessionStorage.disconnected",
                      )
                    )
                  }
                />
              }
            >
              {(currentStatus) => renderInventory(currentStatus)}
            </Show>
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
                    ref={(element) => {
                      ageInput = element;
                    }}
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
                      runOperation() !== null || status()?.maintenance.running
                        ? "configView.sessionStorage.running"
                        : "configView.sessionStorage.runNow",
                    )}
                  </button>
                }
              />
              {runError() && runError() !== status()?.maintenance.lastError ? (
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
    </>
  );
}

export const SessionStorageSettings = defineSolidBridge<SettingsProps>(
  "openclaw-session-storage-settings",
  (props) => <SessionStorageSettingsContent {...props} />,
  {
    properties: {
      mutationDisabled: { default: false, type: Boolean },
      buildEditor: { default: undefined, attribute: false },
      advancedExpanded: { default: false, type: Boolean },
    },
  },
);
