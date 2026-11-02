import "../../styles/logs.css";
import type { LogsTailResult } from "@openclaw/gateway-protocol";
import { createSignal, createStore, onSettled } from "solid-js";
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
import { DEFAULT_LOG_LEVEL_FILTERS, parseLogLine, type LogLevel } from "./log-lines.ts";
import { LogsView, type LogRow, type LogsReadCompletion } from "./view.tsx";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-logs-page": HTMLAttributes<HTMLElement>;
    }
  }
}

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

export function renderSolid() {
  return (
    <ShellLayoutBoundary traits={{ logsPage: true, toolbarHeader: true, settingsWorkspace: true }}>
      <LogsPage />
    </ShellLayoutBoundary>
  );
}

function LogsPage() {
  const context = useApplication();
  const [status, setStatus] = createSignal(createPanelRefreshStatus(), { ownedWrite: true });
  const [file, setFile] = createSignal<string | null>(null, { ownedWrite: true });
  const [entries, setEntries] = createStore<LogRow[]>([], { shallow: true });
  const [filterText, setFilterText] = createSignal("");
  const [levelFilters, setLevelFilters] = createStore<Record<LogLevel, boolean>>({
    ...DEFAULT_LOG_LEVEL_FILTERS,
  });
  const [autoFollow, setAutoFollow] = createSignal(true);
  const [truncated, setTruncated] = createSignal(false, { ownedWrite: true });
  const [completion, setCompletion] = createSignal<LogsReadCompletion | null>(null, {
    ownedWrite: true,
  });
  let cursor: number | null = null;
  let cursorBootId: string | undefined;
  let request:
    | (LogsReadCompletion & {
        controller: AbortController;
        resolve: (status: ReturnType<typeof createPanelRefreshStatus> | null) => void;
      })
    | null = null;
  let disposed = false;
  let stream: HTMLElement | undefined;
  let scrollToEnd: (() => void) | undefined;
  let nextRowId = 0;

  const cancelRequest = () => {
    request?.controller.abort();
    request?.resolve(null);
    request = null;
    setCompletion(null);
  };
  const polling = useVisiblePoll(LOGS_POLL_INTERVAL_MS, () => void loadLogs({ quiet: true }));
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      cursor = null;
      cursorBootId = undefined;
      setStatus(createPanelRefreshStatus());
      setFile(null);
      setEntries(() => []);
      setTruncated(false);
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
          scrollToEnd?.();
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
    const result = Promise.withResolvers<ReturnType<typeof createPanelRefreshStatus> | null>();
    const current = { controller: new AbortController(), quiet: Boolean(options.quiet), ...result };
    request = current;
    setCompletion(current);
    setStatus((previous) => beginPanelRefresh(previous, { clearError: !options.quiet }));
    const bootId = gateway.snapshot?.hello?.server?.bootId;
    const resetCursor = options.reset || bootId !== cursorBootId;
    const previousCursor = resetCursor ? null : cursor;
    const previousFile = file();
    const isCurrent = () =>
      !disposed && request === current && context.gateway === source && gateway.isCurrent(scope);
    let accepted: ReturnType<typeof createPanelRefreshStatus> | null = null;
    try {
      const tail = (nextCursor?: number) =>
        scope.client.request<LogsTailResult>(
          "logs.tail",
          { cursor: nextCursor, limit: 500, maxBytes: 250_000 },
          { signal: current.controller.signal },
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
      const nextEntries = payload.lines.map((line) => ({ ...parseLogLine(line), id: nextRowId++ }));
      const reset = resetCursor || sourceChanged || payload.reset || previousCursor === null;
      // Truncation belongs to the displayed history until a complete tail replaces it.
      setTruncated(
        Boolean(payload.truncated) ||
          (!reset && truncated()) ||
          (reset ? nextEntries.length : entries.length + nextEntries.length) > LOG_BUFFER_LIMIT,
      );
      setEntries((draft) => {
        if (reset) {
          draft.length = 0;
        }
        draft.push(...nextEntries);
        draft.splice(0, Math.max(0, draft.length - LOG_BUFFER_LIMIT));
      });
      cursor = payload.cursor;
      cursorBootId = bootId;
      setFile(payload.file);
      accepted = completePanelRefresh();
      setStatus(accepted);
      return true;
    } catch (error) {
      if (!isCurrent()) {
        return false;
      }
      if (isMissingOperatorReadScopeError(error)) {
        setEntries(() => []);
        setTruncated(false);
        const failed = failPanelRefresh(createPanelRefreshStatus(), error, gateway.snapshot);
        accepted = failed.error
          ? { ...failed, error: formatMissingOperatorReadScopeMessage("logs") }
          : failed;
      } else {
        accepted = failPanelRefresh(status(), error, gateway.snapshot);
      }
      setStatus(accepted);
      return false;
    } finally {
      if (request === current) {
        current.resolve(accepted);
        request = null;
      }
    }
  }

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
    return () => {
      disposed = true;
      request?.controller.abort();
      request?.resolve(null);
      request = null;
      cancelAnimationFrame(frame);
    };
  });

  return (
    <openclaw-logs-page>
      <ShellLayoutBoundary traits={{ logsPage: true, toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{t("tabs.logs")}</h1>
          </div>
        </section>
        <SettingsWorkspace fillHeight>
          <LogsView
            completion={completion()}
            refreshDisabled={!gateway.connected}
            status={status()}
            file={file()}
            entries={entries}
            filterText={filterText()}
            levelFilters={levelFilters}
            autoFollow={autoFollow()}
            truncated={truncated()}
            onStreamRef={(element, scroll) => {
              stream = element;
              scrollToEnd = scroll;
            }}
            onFilterTextChange={setFilterText}
            onLevelToggle={(level, enabled) =>
              setLevelFilters((draft) => {
                draft[level] = enabled;
              })
            }
            onToggleAutoFollow={(enabled) => {
              setAutoFollow(enabled);
              if (enabled) {
                scrollToEnd?.();
              }
            }}
            onRefresh={() =>
              void loadLogs({ reset: true }).then((current) => {
                if (current) {
                  scrollToEnd?.();
                }
              })
            }
            onExport={(lines, label) => {
              const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
              downloadTextFile(`openclaw-logs-${label}-${stamp}.log`, `${lines.join("\n")}\n`);
            }}
          />
        </SettingsWorkspace>
      </ShellLayoutBoundary>
    </openclaw-logs-page>
  );
}
