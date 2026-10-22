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
} from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { highlightJsonHtml } from "../../components/markdown-code-blocks.ts";
import { KeyboardShortcut, ShortcutText } from "../../components/solid/kbd.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import {
  SettingsPage,
  SettingsRow as Row,
  SettingsSection as Section,
  SettingsStatus as Status,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadCommandLaneDiagnostics,
  loadGatewayDiagnostics,
} from "../../lib/gateway-diagnostics.ts";
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

function SecurityRow(props: { status: DebugData["status"] }) {
  const summary = () =>
    // SAFETY: status.get publishes numeric security-audit counters in this field.
    (props.status as { securityAudit?: { summary?: Record<string, number> } } | null)?.securityAudit
      ?.summary;
  const critical = () => summary()?.critical ?? 0;
  const warn = () => summary()?.warn ?? 0;
  const label = () => {
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
    <Show when={summary()}>
      <Row
        title={t("debug.security.audit")}
        description={
          <>
            {t("debug.security.runPrefix")} <span class="mono">openclaw security audit --deep</span>{" "}
            {t("debug.security.runSuffix")}
          </>
        }
        control={
          <>
            <Status kind={critical() > 0 ? "danger" : warn() > 0 ? "warn" : "ok"} label={label()} />
          </>
        }
      />
    </Show>
  );
}

const emptyDiagnostics = (): DebugData => ({
  status: null,
  health: null,
  models: [],
  heartbeat: null,
  lanes: [],
  dynamic: null,
});

type Diagnostics = Awaited<ReturnType<typeof loadGatewayDiagnostics>>;
type DebugData = Omit<Diagnostics, "status" | "health"> & {
  status: Diagnostics["status"] | null;
  health: Diagnostics["health"] | null;
};

export function DebugPage() {
  const context: ApplicationContext = useApplication();
  const gateway = projectGateway(context.gateway);
  const events = projectGatewayEventLog(context.gateway);
  const lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  const state: {
    data: DebugData;
    diagnosticsError: string | null;
    liveError: string | null;
    callMethod: string;
    callParams: string;
    callResult: string | null;
    callError: string | null;
  } = {
    data: emptyDiagnostics(),
    diagnosticsError: null,
    liveError: null,
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
  const polling = useVisiblePoll(3000, () => void loadLiveDiagnostics());
  const diagnostics = createPageRequest(publish, {
    task: ([source, selectedAgent]: Parameters<typeof loadGatewayDiagnostics>, { signal }) =>
      loadGatewayDiagnostics(source, selectedAgent, signal),
    onComplete: (data) => {
      state.data = data;
      state.diagnosticsError = state.liveError = null;
    },
    onError: (error) => {
      state.diagnosticsError = formatUiError(error);
    },
  });
  // Poll admission stays quiet; only a completed live read publishes.
  const live = createPageRequest(() => {}, {
    task: async (source: Parameters<typeof loadCommandLaneDiagnostics>[0], { signal }) => {
      const [heartbeat, lanes] = await Promise.all([
        source.request("last-heartbeat", {}, { signal }),
        loadCommandLaneDiagnostics(source, signal),
      ]);
      return { heartbeat, ...lanes };
    },
    onComplete: (data) => {
      state.data = { ...state.data, ...data };
      state.liveError = null;
      publish();
    },
    onError: (error) => {
      state.liveError = formatUiError(error);
      publish();
    },
  });

  function observeRequest(request: { readonly read: Promise<unknown> | null }) {
    // Keep promise identity synchronous; only the ready memo consumes it.
    const receipt = createMemo(
      () => {
        revision();
        return { completion: request.read };
      },
      { equals: (previous, next) => previous.completion === next.completion },
    );
    // The page deliberately retains snapshots while owner updates stay immediate.
    return { receipt, ready: createDeferred(() => receipt().completion) };
  }
  const diagnosticsRead = observeRequest(diagnostics);
  const liveRead = observeRequest(live);

  // Accepted errors survive retries; a full success clears both read owners.
  const readFeedback = () => {
    latest(diagnosticsRead.ready);
    latest(liveRead.ready);
    const error = read("diagnosticsError") ?? read("liveError");
    if (error) {
      throw new Error(error);
    }
    return null;
  };

  function invalidate() {
    diagnostics.cancel();
    live.cancel();
    needsRefresh = true;
    callEpoch += 1;
  }

  async function loadDiagnostics() {
    const scope = lifecycle.capture();
    if (!scope || diagnostics.pending) {
      return;
    }
    live.cancel();
    needsRefresh = false;
    await diagnostics.run([scope.client, context.settingsAgentSelection.state.selectedId]);
  }

  async function loadLiveDiagnostics() {
    const scope = lifecycle.capture();
    if (!scope || diagnostics.pending || live.pending || document.visibilityState === "hidden") {
      return;
    }
    await live.run(scope.client);
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
    const stopGateway = gateway.subscribe(() => {
      const snapshot = gateway.read().snapshot;
      if (lifecycle.transition(snapshot)) {
        invalidate();
      }
      if (client !== snapshot.client) {
        client = snapshot.client;
        state.data = emptyDiagnostics();
        state.callResult = state.callError = state.diagnosticsError = state.liveError = null;
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
      state.data = { ...state.data, models: [] };
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
        class="btn"
        disabled={gateway.read().snapshot.phase !== "connected" || props.pending}
        onClick={() => void loadDiagnostics()}
      >
        {gateway.read().snapshot.phase === "connected" && props.pending
          ? t("common.refreshing")
          : t("common.refresh")}
      </button>
    );
  }

  function DebugPageView() {
    return (
      <SettingsPage wide>
        <Section
          title={t("debug.snapshotsTitle")}
          description={t("debug.snapshotsSubtitle")}
          actions={
            <Loading on={diagnosticsRead.receipt()} fallback={<RefreshButton pending />}>
              <RefreshButton pending={isPending(diagnosticsRead.ready)} />
            </Loading>
          }
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
          <Errored
            fallback={(error) => (
              <div class="settings-row" role="alert">
                <div class="settings-row__text">
                  <span class="settings-row__title">
                    <Status kind="danger" label={t("common.failed")} />
                  </span>
                  <span class="settings-row__desc">{formatUiError(error())}</span>
                </div>
              </div>
            )}
          >
            <Loading>{readFeedback()}</Loading>
          </Errored>
          <SecurityRow status={read("data").status} />
          <For each={["status", "health", "heartbeat"] as const}>
            {(key) => {
              const title = () => t(key === "heartbeat" ? "debug.lastHeartbeat" : `debug.${key}`);
              return (
                <Row
                  title={title()}
                  stacked
                  control={
                    <>
                      <CodeBlock title={title()} value={read("data")[key]} />
                    </>
                  }
                />
              );
            }}
          </For>
        </Section>
        <Section
          title={t("debug.lanes.title")}
          description={t("debug.lanes.subtitle")}
          actions={
            <button class="btn" onClick={() => requestDebugOverlayToggle()}>
              <Show when={!isNativeEmbedHost()} fallback={t("debug.overlay.open")}>
                <ShortcutText
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
                <CommandLaneRows lanes={read("data").lanes} dynamic={read("data").dynamic} />
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
        <Section title={t("debug.modelsTitle")} description={t("debug.modelsSubtitle")}>
          <div class="settings-row settings-row--stacked">
            <CodeBlock title={t("debug.modelsTitle")} value={read("data").models} />
          </div>
        </Section>
        <Section title={t("debug.eventLogTitle")} description={t("debug.eventLogSubtitle")}>
          <For
            each={events.read().entries}
            fallback={<div class="settings-empty">{t("debug.noEvents")}</div>}
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
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{t("tabs.debug")}</h1>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <DebugPageView />
      </SettingsWorkspace>
    </openclaw-debug-page>
  );
}
