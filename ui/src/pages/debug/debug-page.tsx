import {
  createDeferred,
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
  type Accessor,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HealthSnapshot, ModelCatalogResult, StatusSummary } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import { highlightJsonHtml } from "../../components/markdown-code-blocks.ts";
import { KeyboardShortcut, ShortcutText } from "../../components/solid/kbd.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsRow as Row,
  SettingsSection as Section,
  SettingsStatus as Status,
  SettingsEmpty,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { loadCommandLaneDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { formatEventPayload } from "../../lib/presenter.ts";
import { projectGateway, projectGatewayEventLog } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { requestDebugOverlayToggle } from "./debug-overlay-contract.ts";
import { CommandLaneRows } from "./lane-table.tsx";
import "../../styles/debug-data.css";

const formatJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

function CodeBlock(props: { title: string; value: unknown; format?: (value: unknown) => string }) {
  // The highlighter escapes source text; preserve the generated nodes until that value changes.
  const value = createMemo(() => props.value);
  const format = createMemo(() => props.format ?? formatJson);
  const content = createMemo(() => highlightJsonHtml(format()(value())));
  return (
    <SanitizedHtml
      tag="pre"
      class="code-block"
      role="group"
      aria-label={props.title}
      tabindex={0}
      html={content()}
    />
  );
}

function SecurityRow(props: { status: StatusSummary | null; pending: boolean }) {
  const summary = () =>
    // SAFETY: status.get publishes numeric security-audit counters in this field.
    (props.status as { securityAudit?: { summary?: Record<string, number> } } | null)?.securityAudit
      ?.summary;
  const critical = () => summary()?.critical ?? 0;
  const warn = () => summary()?.warn ?? 0;
  const label = () => {
    if (!summary()) {
      return t(props.pending ? "common.loading" : "debug.overlay.unavailable");
    }
    const info = summary()?.info ?? 0;
    const text =
      critical() > 0
        ? t("debug.security.critical", { count: String(critical()) })
        : warn() > 0
          ? t("debug.security.warnings", { count: String(warn()) })
          : t("debug.security.noCriticalIssues");
    return text + (info > 0 ? ` · ${t("debug.security.info", { count: String(info) })}` : "");
  };
  return (
    <Row
      title={t("debug.security.audit")}
      description={
        <>
          {t("debug.security.runPrefix")} <span class="mono">openclaw security audit --deep</span>{" "}
          {t("debug.security.runSuffix")}
        </>
      }
      control={
        <span class="debug-security-status" aria-busy={props.pending ? "true" : "false"}>
          <Status
            kind={!summary() ? "muted" : critical() > 0 ? "danger" : warn() > 0 ? "warn" : "ok"}
            label={label()}
          />
        </span>
      }
    />
  );
}

type DiagnosticArgs = [GatewayBrowserClient, string | null];

function createDiagnosticSource<T>(
  revision: Accessor<number>,
  publish: () => void,
  load: (args: DiagnosticArgs, options: { signal: AbortSignal }) => Promise<T>,
) {
  let snapshot: { value: T } | null = null;
  let error: string | null = null;
  const request = createPageRequest(publish, {
    task: load,
    onComplete: (value) => {
      snapshot = { value };
      error = null;
    },
    onError: (failure) => {
      error = formatUiError(failure);
    },
  });
  const receipt = createMemo(
    () => {
      revision();
      return { completion: request.read };
    },
    { equals: (previous, next) => previous.completion === next.completion },
  );
  const ready = createDeferred(() => receipt().completion);
  return {
    request,
    receipt,
    ready,
    snapshot: () => {
      revision();
      return snapshot;
    },
    pending: () => {
      revision();
      return request.pending;
    },
    feedback: () => {
      latest(ready);
      if (error) {
        throw new Error(error);
      }
      return null;
    },
    reset() {
      request.cancel();
      snapshot = null;
      error = null;
    },
  };
}

type DiagnosticSource<T> = ReturnType<typeof createDiagnosticSource<T>>;

function DiagnosticFeedback<T>(props: { source: DiagnosticSource<T>; onRetry: () => void }) {
  const pending = () => (
    <Status
      kind="muted"
      label={t(props.source.snapshot() ? "common.refreshing" : "common.loading")}
    />
  );
  return (
    <Loading on={props.source.receipt()} fallback={pending()}>
      <Errored
        fallback={(error) => (
          <span role="alert">
            <Status kind="danger" label={t("common.failed")} /> {formatUiError(error())}{" "}
            {props.source.snapshot() ? t("common.staleData") : undefined}{" "}
            <button class="btn" onClick={() => props.onRetry()}>
              {t("common.retry")}
            </button>
          </span>
        )}
      >
        {props.source.feedback()}
        <Show when={isPending(props.source.ready)}>{pending()}</Show>
      </Errored>
    </Loading>
  );
}

export function DebugPage() {
  const context: ApplicationContext = useApplication();
  const gateway = projectGateway(context.gateway);
  const events = projectGatewayEventLog(context.gateway);
  const lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  const state: {
    callMethod: string;
    callParams: string;
    callResult: string | null;
    callError: string | null;
  } = {
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
  };
  let callEpoch = 0;
  let agent = context.settingsAgentSelection.state.selectedId;
  let client = context.gateway.snapshot.client;
  let needsRefresh = true;
  let disposed = false;
  const status = createDiagnosticSource(revision, publish, ([source], { signal }) =>
    source.request<StatusSummary>("status", {}, { signal }),
  );
  const health = createDiagnosticSource(revision, publish, ([source], { signal }) =>
    source.request<HealthSnapshot>("health", {}, { signal }),
  );
  const models = createDiagnosticSource(
    revision,
    publish,
    async ([source, selectedAgent], { signal }) =>
      selectedAgent
        ? (
            await source.request<ModelCatalogResult>(
              "models.list",
              { agentId: selectedAgent.trim(), view: "default" },
              { signal },
            )
          ).models
        : [],
  );
  const heartbeat = createDiagnosticSource(revision, publish, ([source], { signal }) =>
    source.request("last-heartbeat", {}, { signal }),
  );
  const lanes = createDiagnosticSource(revision, publish, ([source], { signal }) =>
    loadCommandLaneDiagnostics(source, signal),
  );
  const sources = [status, health, models, heartbeat, lanes];
  const snapshots = [
    { title: () => t("debug.status"), source: status },
    { title: () => t("debug.health"), source: health },
    { title: () => t("debug.lastHeartbeat"), source: heartbeat },
  ];
  const polling = useVisiblePoll(3000, loadLiveDiagnostics);

  function invalidate() {
    for (const source of sources) {
      source.request.cancel();
    }
    needsRefresh = true;
    callEpoch += 1;
  }

  function reloadSource(source: DiagnosticSource<unknown>) {
    const scope = lifecycle.capture();
    if (scope) {
      void source.request.run([scope.client, context.settingsAgentSelection.state.selectedId]);
    }
  }

  function loadDiagnostics() {
    if (!lifecycle.capture()) {
      return;
    }
    needsRefresh = false;
    for (const source of sources) {
      reloadSource(source);
    }
  }

  function loadLiveDiagnostics() {
    if (document.visibilityState === "hidden") {
      return;
    }
    for (const source of [heartbeat, lanes]) {
      if (!source.request.pending) {
        reloadSource(source);
      }
    }
  }

  function syncPolling() {
    if (lifecycle.capture()) {
      polling.start();
    } else {
      polling.stop();
    }
  }
  onSettled(() => {
    // Every connection transition aborts diagnostics and retires RPC results before reconnect.
    const stopGateway = context.gateway.subscribe(() => {
      const snapshot = context.gateway.snapshot;
      if (lifecycle.transition(snapshot)) {
        invalidate();
      }
      if (client !== snapshot.client) {
        client = snapshot.client;
        for (const source of sources) {
          source.reset();
        }
        state.callResult = state.callError = null;
      }
      if (needsRefresh) {
        void loadDiagnostics();
      }
      syncPolling();
      publish();
    });
    // Each agent transition aborts prior diagnostics, including A-to-B-to-A changes before rendering.
    const stopSelection = context.settingsAgentSelection.subscribe(({ selectedId: next }) => {
      if (agent === next) {
        return;
      }
      agent = next;
      models.reset();
      invalidate();
      void loadDiagnostics();
      publish();
    });
    syncPolling();
    void loadDiagnostics();
    return () => {
      disposed = true;
      invalidate();
      stopSelection();
      stopGateway();
      lifecycle.dispose();
    };
  });

  async function callDebugMethod() {
    const scope = lifecycle.capture();
    if (!scope) {
      return;
    }
    const epoch = ++callEpoch;
    state.callError = state.callResult = null;
    publish();
    try {
      const params: unknown = state.callParams.trim() ? JSON.parse(state.callParams) : {};
      const result = await scope.client.request(state.callMethod.trim(), params);
      if (lifecycle.isCurrent(scope) && epoch === callEpoch) {
        state.callResult = JSON.stringify(result, null, 2);
      }
    } catch (error) {
      if (lifecycle.isCurrent(scope) && epoch === callEpoch) {
        state.callError = formatUiError(error);
      }
    }
    if (!disposed) {
      publish();
    }
  }

  const read = <K extends keyof typeof state>(key: K) => {
    revision();
    return state[key];
  };

  function RefreshButton(props: { pending: boolean }) {
    return (
      <button
        class="btn debug-refresh"
        data-refresh-label={t("common.refresh")}
        data-refreshing-label={t("common.refreshing")}
        disabled={gateway.read().snapshot.phase !== "connected"}
        onClick={() => void loadDiagnostics()}
      >
        <Show
          when={gateway.read().snapshot.phase === "connected" && props.pending}
          fallback={<span>{t("common.refresh")}</span>}
        >
          <span>{t("common.refreshing")}</span>
        </Show>
      </button>
    );
  }

  function DebugPageView() {
    return (
      <SettingsPage wide>
        <Section
          title={t("debug.snapshotsTitle")}
          description={<span class="debug-read-feedback">{t("debug.snapshotsSubtitle")}</span>}
          actions={<RefreshButton pending={sources.some((source) => source.pending())} />}
        >
          <Show
            when={
              gateway.read().snapshot.phase !== "connected" && gateway.read().snapshot.offlineStable
            }
          >
            <Row
              title={<Status kind="muted" label={t("common.offline")} />}
              description={t("debug.offlineSnapshots")}
            />
          </Show>
          <SecurityRow
            status={status.snapshot()?.value ?? null}
            pending={!status.snapshot() && status.pending()}
          />
          <For each={snapshots}>
            {(snapshot) => (
              <Row
                title={
                  <>
                    {snapshot.title()}{" "}
                    <DiagnosticFeedback
                      source={snapshot.source}
                      onRetry={() => reloadSource(snapshot.source)}
                    />
                  </>
                }
                stacked
                control={
                  <Show
                    when={snapshot.source.snapshot()}
                    fallback={
                      <pre
                        class="code-block"
                        role="group"
                        aria-label={snapshot.title()}
                        aria-busy={snapshot.source.pending() ? "true" : "false"}
                      >
                        {t(
                          snapshot.source.pending()
                            ? "common.loading"
                            : "debug.overlay.unavailable",
                        )}
                      </pre>
                    }
                  >
                    {(value) => <CodeBlock title={snapshot.title()} value={value().value} />}
                  </Show>
                }
              />
            )}
          </For>
        </Section>
        <Section
          title={
            <>
              {t("debug.lanes.title")}{" "}
              <DiagnosticFeedback source={lanes} onRetry={() => reloadSource(lanes)} />
            </>
          }
          description={t("debug.lanes.subtitle")}
          actions={
            <button class="btn" onClick={() => requestDebugOverlayToggle()}>
              <Show when={!isNativeEmbedHost()} fallback={t("debug.overlay.open")}>
                <ShortcutText
                  fallback={t("debug.overlay.open")}
                  text={t("debug.overlay.openWithShortcut", { shortcut: "{shortcut}" })}
                  shortcut={() => (
                    <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.debugOverlay} inline />
                  )}
                />
              </Show>
            </button>
          }
        >
          <div class="data-table-container command-lanes-table-wrap">
            <table class="data-table command-lanes-table settings-table--stacked" role="table">
              <thead>
                <tr>
                  <For each={["lane", "active", "queued", "group", "blocked"]}>
                    {(column) => <th scope="col">{t(`debug.lanes.${column}`)}</th>}
                  </For>
                </tr>
              </thead>
              <tbody>
                <Show when={lanes.snapshot()}>
                  {(snapshot) => (
                    <CommandLaneRows
                      lanes={snapshot().value.lanes}
                      dynamic={snapshot().value.dynamic}
                    />
                  )}
                </Show>
              </tbody>
            </table>
          </div>
        </Section>
        <Section title={t("debug.manualRpcTitle")} description={t("debug.manualRpcSubtitle")}>
          <Row
            title={t("debug.method")}
            control={
              <>
                <select
                  class="settings-select"
                  aria-label={t("debug.method")}
                  value={read("callMethod")}
                  onChange={(event) => {
                    state.callMethod = event.currentTarget.value;
                    publish();
                  }}
                >
                  <Show when={!read("callMethod")}>
                    <option value="" disabled>
                      {t("debug.selectMethod")}
                    </option>
                  </Show>
                  <For each={(gateway.read().snapshot.hello?.features?.methods ?? []).toSorted()}>
                    {(method) => <option value={method}>{method}</option>}
                  </For>
                </select>
              </>
            }
          />
          <Row
            title={t("debug.paramsJson")}
            stacked
            control={
              <>
                <textarea
                  class="settings-input"
                  aria-label={t("debug.paramsJson")}
                  value={read("callParams")}
                  onInput={(event) => {
                    state.callParams = event.currentTarget.value;
                    publish();
                  }}
                  rows={6}
                />
              </>
            }
          />
          <Row
            title={t("common.call")}
            control={
              <>
                <button class="btn primary" onClick={() => void callDebugMethod()}>
                  {t("common.call")}
                </button>
              </>
            }
          />
          <Show when={read("callError")}>
            <div class="settings-row settings-row--stacked" role="alert">
              <Status kind="danger" label={t("debug.callFailed")} />
              <pre class="code-block" role="group" aria-label={t("debug.callFailed")} tabindex={0}>
                {read("callError")}
              </pre>
            </div>
          </Show>
          <Show when={read("callResult")}>
            <div class="settings-row settings-row--stacked">
              <Status kind="ok" label={t("common.ok")} />
              <CodeBlock
                title={`${read("callMethod")}: ${t("common.ok")}`}
                value={read("callResult") ?? ""}
                format={String}
              />
            </div>
          </Show>
        </Section>
        <Section
          title={
            <>
              {t("debug.modelsTitle")}{" "}
              <DiagnosticFeedback source={models} onRetry={() => reloadSource(models)} />
            </>
          }
          description={t("debug.modelsSubtitle")}
        >
          <div class="settings-row settings-row--stacked">
            <Show
              when={models.snapshot()}
              fallback={
                <pre
                  class="code-block"
                  role="group"
                  aria-label={t("debug.modelsTitle")}
                  aria-busy={models.pending() ? "true" : "false"}
                >
                  {t(models.pending() ? "common.loading" : "debug.overlay.unavailable")}
                </pre>
              }
            >
              {(snapshot) => <CodeBlock title={t("debug.modelsTitle")} value={snapshot().value} />}
            </Show>
          </div>
        </Section>
        <Section title={t("debug.eventLogTitle")} description={t("debug.eventLogSubtitle")}>
          <For
            each={events.read().entries}
            fallback={<SettingsEmpty message={t("debug.noEvents")} />}
          >
            {(event) => (
              <Row
                title={event.event}
                description={formatTimeMs(event.ts, undefined, "")}
                stacked
                control={
                  <>
                    <CodeBlock
                      title={event.event}
                      value={event.payload}
                      format={formatEventPayload}
                    />
                  </>
                }
              />
            )}
          </For>
        </Section>
      </SettingsPage>
    );
  }

  return (
    <openclaw-debug-page>
      <SettingsPageHeader title={t("tabs.debug")} />
      <SettingsWorkspace>
        <DebugPageView />
      </SettingsWorkspace>
    </openclaw-debug-page>
  );
}
