import "../../styles/logs.css";
import { createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "../../components/panel-refresh-status-state.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { downloadTextFile } from "../../lib/download.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import {
  DEFAULT_LOG_LEVEL_FILTERS,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from "./log-lines.ts";
import { LogsView } from "./view.tsx";

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

type LogsPayload = {
  file?: string;
  cursor?: number;
  lines?: unknown;
  truncated?: boolean;
  reset?: boolean;
};

function LogsPageContent(props: { host: HTMLElement }) {
  const context = useApplication();
  const [status, setStatus] = createSignal(createPanelRefreshStatus(), { ownedWrite: true });
  const [file, setFile] = createSignal<string | null>(null, { ownedWrite: true });
  const [entries, setEntries] = createSignal<LogEntry[]>([], { ownedWrite: true });
  const [filterText, setFilterText] = createSignal("");
  const [levelFilters, setLevelFilters] = createSignal<Record<LogLevel, boolean>>({
    ...DEFAULT_LOG_LEVEL_FILTERS,
  });
  const [autoFollow, setAutoFollow] = createSignal(true);
  const [truncated, setTruncated] = createSignal(false, { ownedWrite: true });
  const [requestState, setRequestState] = createSignal<"idle" | "quiet" | "visible">("idle", {
    ownedWrite: true,
  });
  const [forceFollow, setForceFollow] = createSignal(0);
  let cursor: number | null = null;
  let request: AbortController | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let connected = false;
  let disposed = false;
  let atBottom = true;
  let stream: HTMLElement | undefined;
  let followFrame: number | undefined;

  const cancelRequest = () => {
    request?.abort();
    request = null;
    setRequestState("idle");
  };
  const updatePolling = () => {
    const shouldPoll = connected && document.visibilityState !== "hidden";
    if (!shouldPoll && pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    } else if (shouldPoll && pollTimer === undefined) {
      pollTimer = setInterval(() => void loadLogs({ quiet: true }), LOGS_POLL_INTERVAL_MS);
      return true;
    }
    return false;
  };
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      cursor = null;
      setStatus(createPanelRefreshStatus());
      setFile(null);
      setEntries([]);
      setTruncated(false);
      atBottom = true;
    },
    invalidateRequests: cancelRequest,
    onSnapshot: (change) => {
      connected = change.snapshot.phase === "connected" && change.snapshot.client !== null;
      updatePolling();
    },
    ensureInitialData: (change) => {
      const quiet = !change.identityChanged && untrack(status).hasLoaded;
      void loadLogs({ reset: true, quiet }).then((current) => {
        if (current && !quiet) {
          setForceFollow((revision) => revision + 1);
        }
      });
    },
  });

  async function loadLogs(options: { reset?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    const scope = gateway.capture();
    const source = gateway.gateway;
    if (!scope || context.gateway !== source || (request && !options.reset)) {
      return false;
    }
    cancelRequest();
    const current = new AbortController();
    request = current;
    setRequestState(options.quiet ? "quiet" : "visible");
    setStatus((previous) => beginPanelRefresh(previous, { clearError: !options.quiet }));
    const previousCursor = options.reset ? null : cursor;
    const previousFile = untrack(file);
    const isCurrent = () =>
      !disposed && request === current && context.gateway === source && gateway.isCurrent(scope);
    try {
      const tail = (nextCursor?: number) =>
        scope.client.request<LogsPayload>(
          "logs.tail",
          { cursor: nextCursor, limit: 500, maxBytes: 250_000 },
          { signal: current.signal },
        );
      let payload = await tail(previousCursor ?? undefined);
      if (!isCurrent()) {
        return false;
      }
      // Cursors belong to one file. Finish the reset before publishing a new source.
      const sourceChanged =
        !options.reset &&
        previousFile !== null &&
        payload.file !== undefined &&
        payload.file !== previousFile;
      if (sourceChanged) {
        payload = await tail();
        if (!isCurrent()) {
          return false;
        }
      }
      const nextEntries = Array.isArray(payload.lines)
        ? payload.lines.filter((line): line is string => typeof line === "string").map(parseLogLine)
        : [];
      const reset = options.reset || sourceChanged || payload.reset || previousCursor === null;
      setEntries((previous) =>
        reset ? nextEntries : [...previous, ...nextEntries].slice(-LOG_BUFFER_LIMIT),
      );
      if (typeof payload.cursor === "number") {
        cursor = payload.cursor;
      }
      if (typeof payload.file === "string") {
        setFile(payload.file);
      }
      setTruncated(Boolean(payload.truncated));
      setStatus(completePanelRefresh());
      return true;
    } catch (error) {
      if (!isCurrent()) {
        return false;
      }
      if (isMissingOperatorReadScopeError(error)) {
        setEntries([]);
        const failed = failPanelRefresh(createPanelRefreshStatus(), error, gateway.snapshot);
        setStatus(
          failed.error
            ? { ...failed, error: formatMissingOperatorReadScopeMessage("logs") }
            : failed,
        );
      } else {
        setStatus((previous) => failPanelRefresh(previous, error, gateway.snapshot));
      }
      return false;
    } finally {
      if (request === current) {
        request = null;
        setRequestState("idle");
      }
    }
  }

  const scheduleFollow = (force = false) => {
    if (followFrame !== undefined) {
      cancelAnimationFrame(followFrame);
      followFrame = undefined;
    }
    const scope = gateway.capture();
    if (!scope || disposed) {
      return;
    }
    followFrame = requestAnimationFrame(() => {
      followFrame = undefined;
      if (!stream || disposed || !gateway.isCurrent(scope)) {
        return;
      }
      const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
      if (!force && (!untrack(autoFollow) || (!atBottom && distance >= 120))) {
        return;
      }
      stream.scrollTop = stream.scrollHeight;
      atBottom = true;
    });
  };
  createEffect(entries, () => {
    if (untrack(autoFollow) && atBottom) {
      scheduleFollow();
    }
  });
  createEffect(autoFollow, (enabled) => {
    if (enabled) {
      scheduleFollow(true);
    }
  });
  createEffect(forceFollow, (revision) => {
    if (revision > 0) {
      scheduleFollow(true);
    }
  });
  const visibilityChanged = () => {
    if (updatePolling()) {
      void loadLogs({ quiet: true });
    }
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  onCleanup(() => {
    disposed = true;
    cancelRequest();
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
    }
    if (followFrame !== undefined) {
      cancelAnimationFrame(followFrame);
    }
    document.removeEventListener("visibilitychange", visibilityChanged);
  });
  onSettled(() => {
    stream = props.host.querySelector<HTMLElement>(".log-stream") ?? undefined;
    const resetContentScroll = () => {
      const content = props.host.closest<HTMLElement>(".content");
      if (content) {
        content.scrollTop = 0;
        content.scrollLeft = 0;
      }
    };
    resetContentScroll();
    const frame = requestAnimationFrame(resetContentScroll);
    return () => cancelAnimationFrame(frame);
  });

  return (
    <ShellLayoutBoundary traits={{ logsPage: true, toolbarHeader: true }}>
      <section class="content-header">
        <div>
          <div class="page-title">{t("tabs.logs")}</div>
        </div>
      </section>
      <SettingsWorkspace fillHeight>
        <LogsView
          loading={requestState() === "visible"}
          refreshDisabled={!gateway.connected || requestState() !== "idle"}
          status={status()}
          file={file()}
          entries={entries()}
          filterText={filterText()}
          levelFilters={levelFilters()}
          autoFollow={autoFollow()}
          truncated={truncated()}
          onFilterTextChange={setFilterText}
          onLevelToggle={(level, enabled) =>
            setLevelFilters((previous) => ({ ...previous, [level]: enabled }))
          }
          onToggleAutoFollow={setAutoFollow}
          onRefresh={() =>
            void loadLogs({ reset: true }).then((current) => {
              if (current) {
                setForceFollow((revision) => revision + 1);
              }
            })
          }
          onExport={(lines, label) => {
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            downloadTextFile(`openclaw-logs-${label}-${stamp}.log`, `${lines.join("\n")}\n`);
          }}
          onScroll={(event) => {
            const target = event.currentTarget;
            atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
          }}
        />
      </SettingsWorkspace>
    </ShellLayoutBoundary>
  );
}

export const LogsPage = defineSolidBridge(
  "openclaw-logs-page",
  (_props, host) => <LogsPageContent host={host} />,
  { properties: {} },
);
