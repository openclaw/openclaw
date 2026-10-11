import { createSignal, onCleanup } from "solid-js";
import type { CronStatus } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadCommandLaneDiagnostics,
  loadGatewayDiagnostics,
} from "../../lib/gateway-diagnostics.ts";
import {
  projectAgentSelection,
  projectGateway,
  projectGatewayEventLog,
} from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import "../../styles/debug-data.css";
import { requestDebugOverlayToggle } from "./debug-overlay-contract.ts";
import { DebugPageView } from "./view.tsx";

const emptyDiagnostics = (): DebugData => ({
  status: null,
  health: null,
  models: [],
  automations: null,
  lanes: [],
  dynamic: null,
});
type Diagnostics = Awaited<ReturnType<typeof loadGatewayDiagnostics>>;
type DebugData = Omit<Diagnostics, "status" | "health"> & {
  status: Diagnostics["status"] | null;
  health: Diagnostics["health"] | null;
};

function DebugPageContent() {
  const context: ApplicationContext = useApplication();
  const gateway = projectGateway(context.gateway);
  const events = projectGatewayEventLog(context.gateway);
  const selection = projectAgentSelection(context.settingsAgentSelection);
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
  let fullFlight: AbortController | undefined;
  let liveFlight: AbortController | undefined;
  let callEpoch = 0;
  let agent = context.settingsAgentSelection.state.selectedId;
  let client = context.gateway.snapshot.client;
  let needsRefresh = true;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function invalidate() {
    fullFlight?.abort();
    liveFlight?.abort();
    fullFlight = liveFlight = undefined;
    needsRefresh = true;
    callEpoch += 1;
  }

  async function loadDiagnostics() {
    const scope = lifecycle.capture();
    if (!scope || fullFlight) {
      return;
    }
    liveFlight?.abort();
    liveFlight = undefined;
    const controller = new AbortController();
    fullFlight = controller;
    needsRefresh = false;
    const selectedAgent = context.settingsAgentSelection.state.selectedId;
    publish();
    try {
      const data = await loadGatewayDiagnostics(scope.client, selectedAgent, controller.signal);
      if (
        !disposed &&
        !controller.signal.aborted &&
        lifecycle.isCurrent(scope) &&
        selectedAgent === context.settingsAgentSelection.state.selectedId
      ) {
        state.data = data;
        state.diagnosticsError = state.liveError = null;
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted && lifecycle.isCurrent(scope)) {
        state.diagnosticsError = formatUiError(error);
      }
    } finally {
      if (fullFlight === controller) {
        fullFlight = undefined;
        publish();
      }
    }
  }

  async function loadLiveDiagnostics() {
    const scope = lifecycle.capture();
    if (!scope || fullFlight || liveFlight || document.visibilityState === "hidden") {
      return;
    }
    const controller = new AbortController();
    liveFlight = controller;
    try {
      const [automations, lanes] = await Promise.all([
        scope.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
        loadCommandLaneDiagnostics(scope.client, controller.signal),
      ]);
      if (!disposed && !controller.signal.aborted && lifecycle.isCurrent(scope)) {
        state.data = { ...state.data, automations, ...lanes };
        state.liveError = null;
        publish();
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted && lifecycle.isCurrent(scope)) {
        state.liveError = formatUiError(error);
        publish();
      }
    } finally {
      if (liveFlight === controller) {
        liveFlight = undefined;
      }
    }
  }

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
  const stopSelection = selection.subscribe(() => {
    const next = selection.read().state.selectedId;
    if (agent === next) {
      return;
    }
    agent = next;
    state.data = { ...state.data, models: [] };
    invalidate();
    void loadDiagnostics();
    publish();
  });
  function syncPolling() {
    if (!lifecycle.capture() || document.visibilityState === "hidden") {
      clearInterval(timer);
      timer = undefined;
    } else if (timer === undefined) {
      timer = setInterval(() => void loadLiveDiagnostics(), 3000);
    }
  }
  const visibilityChanged = () => {
    const wasStopped = timer === undefined;
    syncPolling();
    if (wasStopped && timer !== undefined) {
      void loadLiveDiagnostics();
    }
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  syncPolling();
  void loadDiagnostics();
  onCleanup(() => {
    disposed = true;
    invalidate();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visibilityChanged);
    stopSelection();
    stopGateway();
    lifecycle.dispose();
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
  return (
    <>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <div class="page-title">{t("tabs.debug")}</div>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <DebugPageView
          connected={gateway.read().snapshot.phase === "connected"}
          offlineStable={gateway.read().snapshot.offlineStable}
          loading={(revision(), Boolean(fullFlight))}
          status={read("data").status}
          health={read("data").health}
          models={read("data").models}
          automations={read("data").automations}
          lanes={read("data").lanes}
          dynamic={read("data").dynamic}
          diagnosticsError={read("diagnosticsError") ?? read("liveError")}
          eventLog={events.read().entries}
          methods={(gateway.read().snapshot.hello?.features?.methods ?? []).toSorted()}
          callMethod={read("callMethod")}
          callParams={read("callParams")}
          callResult={read("callResult")}
          callError={read("callError")}
          onCallMethodChange={(next) => {
            state.callMethod = next;
            publish();
          }}
          onCallParamsChange={(next) => {
            state.callParams = next;
            publish();
          }}
          onRefresh={() => void loadDiagnostics()}
          onOpenOverlay={requestDebugOverlayToggle}
          onCall={() => void callDebugMethod()}
        />
      </SettingsWorkspace>
    </>
  );
}

export const DebugPage = defineSolidBridge("openclaw-debug-page", DebugPageContent, {
  properties: {},
});
