import "../../styles/logs.css";
import type { LogsTailResult } from "@openclaw/gateway-protocol";
import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
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
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import {
  DEFAULT_LOG_LEVEL_FILTERS,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from "./log-lines.ts";
import { LogsView } from "./view.tsx";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-logs-page": HTMLAttributes<HTMLElement>;
    }
  }
}

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

export function LogsPage() {
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
  let cursorBootId: string | undefined;
  let request: AbortController | null = null;
  let disposed = false;
  let atBottom = true;
  let stream: HTMLElement | undefined;
  let followFrame: number | undefined;

  const cancelRequest = () => {
    request?.abort();
    request = null;
    setRequestState("idle");
  };
  const polling = useVisiblePoll(LOGS_POLL_INTERVAL_MS, () => void loadLogs({ quiet: true }));
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      cursor = null;
      cursorBootId = undefined;
      setStatus(createPanelRefreshStatus());
      setFile(null);
      setEntries([]);
      setTruncated(false);
      atBottom = true;
    },
    invalidateRequests: cancelRequest,
    onSnapshot: () => {
      if (gateway.connected && gateway.client !== null) {
        polling.start();
      } else {
        polling.stop();
      }
    },
    ensureInitialData: (change) => {
      const quiet = !change.identityChanged && status().hasLoaded;
      // A same-Gateway reconnect resumes the cursor; a full window costs a busy Gateway one
      // file read and redaction pass per reconnect.
      void loadLogs({ reset: !quiet || cursor === null, quiet }).then((current) => {
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
    const bootId = gateway.snapshot?.hello?.server?.bootId;
    const resetCursor = options.reset || bootId !== cursorBootId;
    const previousCursor = resetCursor ? null : cursor;
    const previousFile = file();
    const isCurrent = () =>
      !disposed && request === current && context.gateway === source && gateway.isCurrent(scope);
    try {
      const tail = (nextCursor?: number) =>
        scope.client.request<LogsTailResult>(
          "logs.tail",
          { cursor: nextCursor, limit: 500, maxBytes: 250_000 },
          { signal: current.signal },
        );
      let payload = await tail(previousCursor ?? undefined);
      if (!isCurrent()) {
        return false;
      }
      // Cursors belong to one server boot and file. Finish the reset before publishing a new source.
      const sourceChanged = !resetCursor && previousFile !== null && payload.file !== previousFile;
      if (sourceChanged) {
        payload = await tail();
        if (!isCurrent()) {
          return false;
        }
      }
      const nextEntries = payload.lines.map(parseLogLine);
      const reset = resetCursor || sourceChanged || payload.reset || previousCursor === null;
      setEntries((previous) =>
        reset ? nextEntries : [...previous, ...nextEntries].slice(-LOG_BUFFER_LIMIT),
      );
      cursor = payload.cursor;
      cursorBootId = bootId;
      setFile(payload.file);
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
      if (!force && (!autoFollow() || (!atBottom && distance >= 120))) {
        return;
      }
      stream.scrollTop = stream.scrollHeight;
      atBottom = true;
    });
  };
  // One DOM follow operation owns appends, operator opt-in, and explicit refreshes.
  createEffect(
    () => ({ entries: entries(), enabled: autoFollow(), revision: forceFollow() }),
    ({ enabled, revision }, previous) => {
      const force =
        (revision > 0 && revision !== previous?.revision) || (enabled && !previous?.enabled);
      if (force || (enabled && atBottom)) {
        scheduleFollow(force);
      }
    },
  );
  onCleanup(() => {
    disposed = true;
    cancelRequest();
    if (followFrame !== undefined) {
      cancelAnimationFrame(followFrame);
    }
  });
  onSettled(() => {
    const resetContentScroll = () => {
      const content = stream?.closest<HTMLElement>(".content");
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
    <openclaw-logs-page>
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
            onStreamRef={(element) => (stream = element)}
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
    </openclaw-logs-page>
  );
}
