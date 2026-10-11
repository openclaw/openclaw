import "./meetings.css";
import type {
  TranscriptsExportParams,
  TranscriptsExportResult,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import {
  transcriptListParams,
  transcriptRouteSearch,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";
import { TranscriptsView } from "./view.tsx";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ArchiveReadResults = {
  "transcripts.list": TranscriptsListResult;
  "transcripts.get": TranscriptsGetResult;
  "transcripts.export": TranscriptsExportResult;
};
type OperationState = { kind: "idle" | "loading" | "done" | "error"; message?: string };
// Requests stay synchronous; the revision only publishes their presentation state.
function createArchiveRead(run: (signal: AbortSignal) => Promise<void>) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let abort: AbortController | null = null;
  let error: unknown = null;
  const publish = () => setRevision((value) => value + 1);
  const cancel = () => {
    abort?.abort();
    abort = null;
    error = null;
    publish();
  };
  onCleanup(cancel);
  return {
    get pending() {
      revision();
      return abort !== null;
    },
    get error() {
      revision();
      return error;
    },
    abort: cancel,
    async run() {
      cancel();
      const current = new AbortController();
      abort = current;
      publish();
      try {
        await run(current.signal);
      } catch (cause) {
        if (abort === current && !current.signal.aborted) {
          error = cause;
        }
      } finally {
        if (abort === current) {
          abort = null;
          publish();
        }
      }
    },
  };
}

export const MeetingsPage = defineSolidBridge<{ routeSearch: string }>(
  "openclaw-meetings-page",
  (props, host) => {
    const context = useApplication();
    const projection = projectGateway(context.gateway);
    const gateway = createGatewayConnectionLifecycle(context.gateway.snapshot);
    let active = true;
    const [drafts, setDrafts] = createSignal<Record<string, string>>({}, { ownedWrite: true });
    const [list, setList] = createSignal<TranscriptsListResult | null>(null, { ownedWrite: true });
    const [listDenial, setListDenial] = createSignal<unknown>(null, { ownedWrite: true });
    const [readerDenial, setReaderDenial] = createSignal<unknown>(null, { ownedWrite: true });
    let accessGeneration = 0;
    let readerCursor: string | null = null;
    let loadedReaderCursor: string | null = null;
    let lastReaderRefresh = 0;
    const [now, setNow] = createSignal(Date.now());
    const [summary, setSummary] = createSignal<TranscriptsGetResult | null>(null, {
      ownedWrite: true,
    });
    const [summaryGeneration, setSummaryGeneration] = createSignal<OperationState>(
      { kind: "idle" },
      { ownedWrite: true },
    );
    let summaryAbort: AbortController | null = null;
    const [readerPages, setReaderPages] = createSignal<TranscriptsGetResult[]>([], {
      ownedWrite: true,
    });
    const [exportState, setExportState] = createSignal<OperationState>(
      { kind: "idle" },
      { ownedWrite: true },
    );
    let exportAbort: AbortController | null = null;
    let focusSelection = false;

    const listTask = createArchiveRead(async (signal) => {
      const client = requestClient();
      if (!client) {
        return;
      }
      const params = transcriptListParams(props.routeSearch);
      const selector = selection().selector;
      await readArchive({
        client,
        method: "transcripts.list",
        params,
        signal,
        current: () =>
          selection().selector === selector &&
          JSON.stringify(transcriptListParams(props.routeSearch)) === JSON.stringify(params),
        accept: (result) => {
          setListDenial(null);
          setList(result);
        },
      });
    });
    const summaryTask = createArchiveRead(async (signal) => {
      const client = requestClient();
      const selector = selection().selector;
      if (!client || !selector) {
        return;
      }
      await readArchive({
        client,
        method: "transcripts.get",
        params: { selector },
        signal,
        current: () => selection().selector === selector,
        accept: (result) => {
          setReaderDenial(null);
          setSummary(result);
        },
      });
    });
    const readerTask = createArchiveRead(async (signal) => {
      const client = requestClient();
      const { selector, query } = selection();
      const cursor = readerCursor;
      if (!client || !selector) {
        return;
      }
      await readArchive({
        client,
        method: "transcripts.get",
        params: {
          selector,
          includeUtterances: true,
          query: query || undefined,
          cursor: cursor ?? undefined,
          limit: TRANSCRIPT_PAGE_SIZE,
        },
        signal,
        current: () =>
          selection().selector === selector &&
          selection().query === query &&
          readerCursor === cursor,
        accept: (result, current) => {
          setReaderDenial(null);
          // A background read replaces the current page; only forward paging appends.
          setReaderPages((pages) =>
            cursor
              ? [...(cursor === loadedReaderCursor ? pages.slice(0, -1) : pages), result]
              : [result],
          );
          loadedReaderCursor = cursor;
          if (
            document.visibilityState !== "hidden" &&
            result.nextCursor &&
            result.nextCursor !== cursor
          ) {
            const nextCursor = result.nextCursor;
            queueMicrotask(() => {
              if (current()) {
                readerCursor = nextCursor;
                void readerTask.run();
              }
            });
          }
        },
      });
    });
    function requestClient() {
      const snapshot = context?.gateway.snapshot;
      return active &&
        snapshot?.phase === "connected" &&
        hasOperatorReadAccess(snapshot.hello?.auth ?? null)
        ? snapshot.client
        : null;
    }

    function selection() {
      const query = new URLSearchParams(props.routeSearch);
      return {
        selector: query.get("selector") ?? "",
        query: (query.get("find") ?? "").slice(0, TRANSCRIPT_QUERY_LIMIT),
      };
    }

    function readerTab(): "text" | "summary" {
      const params = new URLSearchParams(props.routeSearch);
      if (params.has("tab")) {
        return params.get("tab") === "transcript" ? "text" : "summary";
      }
      return selection().query ? "text" : "summary";
    }

    function captureArchiveRequest(client: GatewayClient | null) {
      const scope = gateway.capture();
      const owner = context.gateway;
      const hello = owner.snapshot.hello;
      const auth = owner.snapshot.hello?.auth;
      const generation = accessGeneration;
      return {
        scope,
        auth,
        isCurrent: () =>
          requestClient() === client &&
          context.gateway === owner &&
          owner.snapshot.hello === hello &&
          owner.snapshot.hello?.auth === auth &&
          scope !== null &&
          gateway.isCurrent(scope) &&
          accessGeneration === generation,
      };
    }

    async function readArchive<Method extends keyof ArchiveReadResults>(request: {
      client: GatewayClient;
      method: Method;
      params: unknown;
      signal: AbortSignal;
      current: () => boolean;
      accept: (result: ArchiveReadResults[Method], current: () => boolean) => void;
    }) {
      const requestScope = captureArchiveRequest(request.client);
      const current = () =>
        !request.signal.aborted && requestScope.isCurrent() && request.current();
      try {
        const result = await request.client.request<ArchiveReadResults[Method]>(
          request.method,
          request.params,
          {
            signal: request.signal,
          },
        );
        if (!current()) {
          return;
        }
        return request.accept(result, current);
      } catch (error) {
        if (!current()) {
          return;
        }
        if (isArchiveAccessDeniedError(error)) {
          // Archive access is shared across these RPCs. Retire every older request,
          // but leave cursor intent alone: denial requires an explicit retry.
          accessGeneration++;
          cancelSummaryGeneration();
          setListDenial(error);
          setReaderDenial(error);
          setList(null);
          setSummary(null);
          setReaderPages([]);
          cancelExport();
        }
        throw error;
      }
    }

    function resetConnection() {
      cancelSummaryGeneration();
      setList(null);
      setListDenial(null);
      setReaderDenial(null);
      setSummary(null);
      lastReaderRefresh = 0;
      listTask.abort();
      summaryTask.abort();
      readerTask.abort();
      cancelExport();
      resetReader();
    }

    function resetReader() {
      readerCursor = null;
      loadedReaderCursor = null;
      setReaderPages([]);
    }

    function cancelExport() {
      exportAbort?.abort();
      exportAbort = null;
      setExportState({ kind: "idle" });
    }

    function cancelSummaryGeneration() {
      summaryAbort?.abort();
      summaryAbort = null;
      setSummaryGeneration({ kind: "idle" });
    }

    async function generateMissingSummary(retry = false, page = summary()) {
      const client = requestClient();
      const { selector } = selection();
      const requestScope = captureArchiveRequest(client);
      if (
        !client ||
        !selector ||
        !requestScope.scope ||
        readerDenial() ||
        !hasOperatorWriteAccess(requestScope.auth ?? null) ||
        !page ||
        page.summary ||
        page.session.utteranceCount === 0 ||
        summaryAbort !== null ||
        (!retry && summaryGeneration().kind !== "idle")
      ) {
        return;
      }
      const abort = new AbortController();
      summaryAbort = abort;
      setSummaryGeneration({ kind: "loading" });
      const current = () =>
        !abort.signal.aborted &&
        summaryAbort === abort &&
        requestScope.isCurrent() &&
        selection().selector === selector;
      try {
        const result = await client.request<TranscriptsGetResult>(
          "transcripts.summarize",
          { selector },
          {
            signal: abort.signal,
            // Allow the shared summary lane to drain an earlier generation before inference.
            timeoutMs: 120000,
          },
        );
        if (!current()) {
          return;
        }
        summaryTask.abort();
        setSummary(result);
        setSummaryGeneration({ kind: "done" });
      } catch (error) {
        if (current()) {
          setSummaryGeneration({ kind: "error", message: formatUiError(error) });
        }
      } finally {
        if (summaryAbort === abort) {
          summaryAbort = null;
        }
      }
    }

    function navigate(patch: Record<string, string | null>) {
      // Clear/submit must also synchronize when the URL value was already equal.
      setDrafts((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? ""])),
      }));
      context.navigate("meetings", {
        search: transcriptRouteSearch(props.routeSearch, patch),
      });
    }

    function refresh() {
      cancelExport();
      setSummary(null);
      resetReader();
      // A refresh starts a new cursor snapshot, rather than reusing an old list page.
      if (new URLSearchParams(props.routeSearch).has("cursor")) {
        navigate({ cursor: null });
      } else {
        void listTask.run();
      }
      void summaryTask.run();
      void readerTask.run();
    }

    function refreshLive(foreground = false) {
      if (
        !requestClient() ||
        document.visibilityState === "hidden" ||
        listDenial() ||
        readerDenial()
      ) {
        return;
      }
      const currentTime = Date.now();
      setNow(currentTime);
      if (!listTask.pending) {
        void listTask.run();
      }
      if (!selection().selector) {
        return;
      }
      const session = summary()?.session ?? readerPages().at(-1)?.session;
      const storedSummary = summary()?.summary;
      const interimSummary =
        session?.stoppedAt &&
        storedSummary?.generatedAt &&
        Date.parse(storedSummary.generatedAt) < Date.parse(session.stoppedAt);
      // Interim notes remain visible while the final summary is being generated.
      const interval = session?.active || !storedSummary || interimSummary ? 3000 : 15000;
      if (!foreground && currentTime - lastReaderRefresh < interval) {
        return;
      }
      lastReaderRefresh = currentTime;
      for (const task of [summaryTask, readerTask]) {
        if (!task.pending) {
          void task.run();
        }
      }
    }

    async function download(format: TranscriptsExportParams["format"]) {
      const client = requestClient();
      const { selector } = selection();
      if (!client || !selector || exportAbort !== null) {
        return;
      }
      const abort = new AbortController();
      exportAbort = abort;
      setExportState({ kind: "loading" });
      try {
        await readArchive({
          client,
          method: "transcripts.export",
          params: { selector, format },
          signal: abort.signal,
          current: () => selection().selector === selector,
          accept: (result) => {
            const bytes = Uint8Array.from(atob(result.data), (character) =>
              character.charCodeAt(0),
            );
            const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
            const anchor = document.createElement("a");
            try {
              anchor.href = url;
              anchor.download = result.filename;
              document.body.append(anchor);
              anchor.click();
              setExportState({ kind: "done" });
            } finally {
              anchor.remove();
              // Allow the browser to consume the object URL before releasing the bytes.
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
          },
        });
      } catch (error) {
        if (exportAbort === abort && !abort.signal.aborted) {
          setExportState({ kind: "error", message: formatUiError(error) });
        }
      } finally {
        if (exportAbort === abort) {
          exportAbort = null;
        }
      }
    }

    createEffect(summary, (page) => {
      if (page) {
        void untrack(() => generateMissingSummary(false, page));
      }
    });

    let previousSearch: string | undefined;
    let previousListParams: string | undefined;
    let connectionHello: unknown;
    let connectionAuth: unknown;
    createEffect(
      () => ({ snapshot: projection.read().snapshot, search: props.routeSearch }),
      ({ snapshot, search }) =>
        untrack(() => {
          const connectionChanged = gateway.transition(snapshot);
          const authorizationChanged =
            snapshot.hello !== connectionHello || snapshot.hello?.auth !== connectionAuth;
          connectionHello = snapshot.hello;
          connectionAuth = snapshot.hello?.auth;
          if (connectionChanged || authorizationChanged) {
            gateway.invalidate();
            resetConnection();
          }
          const previous = new URLSearchParams(previousSearch);
          const next = new URLSearchParams(search);
          const selectorChanged = previous.get("selector") !== next.get("selector");
          const queryChanged = previous.get("find") !== next.get("find");
          const listParams = JSON.stringify(transcriptListParams(search));
          const filtersChanged = previousListParams !== listParams;
          if (selectorChanged) {
            cancelSummaryGeneration();
            setSummary(null);
            lastReaderRefresh = 0;
          }
          if (filtersChanged) {
            setList(null);
          }
          if (previousSearch !== search) {
            setDrafts((current) => {
              const nextDrafts = { ...current };
              for (const key of [...TRANSCRIPT_FILTER_KEYS, "find"]) {
                if (
                  previous.get(key) !== next.get(key) ||
                  previousSearch === undefined ||
                  (key === "find" && selectorChanged)
                ) {
                  nextDrafts[key] = next.get(key) ?? "";
                }
              }
              return nextDrafts;
            });
          }
          if (selectorChanged || queryChanged) {
            resetReader();
            cancelExport();
            focusSelection = previousSearch !== undefined;
          }
          if (connectionChanged || authorizationChanged || filtersChanged || selectorChanged) {
            void listTask.run();
          }
          if (connectionChanged || authorizationChanged || selectorChanged) {
            void summaryTask.run();
          }
          if (connectionChanged || authorizationChanged || selectorChanged || queryChanged) {
            void readerTask.run();
          }
          previousSearch = search;
          previousListParams = listParams;
        }),
    );
    createEffect(
      () => [props.routeSearch, summary(), readerPages(), readerDenial()],
      () =>
        untrack(() => {
          if (!focusSelection) {
            return;
          }
          const target = selection().selector
            ? host.querySelector<HTMLElement>(
                ".transcripts-reader h1, .transcripts-reader [role=alert]",
              )
            : host.querySelector<HTMLElement>('.transcripts-library input[name="query"]');
          if (target) {
            target.focus();
            focusSelection = false;
          }
        }),
    );
    const timer = globalThis.setInterval(() => refreshLive(), 3_000);
    const activate = () => refreshLive(true);
    document.addEventListener("visibilitychange", activate);
    globalThis.addEventListener("focus", activate);
    onCleanup(() => {
      active = false;
      gateway.dispose();
      cancelSummaryGeneration();
      cancelExport();
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", activate);
      globalThis.removeEventListener("focus", activate);
    });

    const activeReaderTask = () => (readerTab() === "summary" ? summaryTask : readerTask);
    return (
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <TranscriptsView
          basePath={context.basePath}
          now={now()}
          search={props.routeSearch}
          drafts={drafts()}
          onDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
          connected={projection.read().snapshot.phase === "connected"}
          allowed={hasOperatorReadAccess(projection.read().snapshot.hello?.auth ?? null)}
          list={requestClient() ? list() : null}
          listLoading={!listDenial() && listTask.pending}
          listError={listDenial() ?? listTask.error}
          reader={{
            summary: summary(),
            pages: readerPages(),
            loading: activeReaderTask().pending,
            error: readerDenial() ?? activeReaderTask().error,
          }}
          readerTab={readerTab()}
          summaryGeneration={summaryGeneration()}
          onSummaryRetry={() => void generateMissingSummary(true)}
          exportState={exportState()}
          onNavigate={navigate}
          onRefresh={refresh}
          onReaderRetry={() => {
            if (readerTab() === "summary") {
              void summaryTask.run();
              return;
            }
            if (!readerPages().length) {
              resetReader();
            }
            if (!summary()) {
              void summaryTask.run();
            }
            void readerTask.run();
          }}
          onReaderTab={(tab) => navigate({ tab: tab === "text" ? "transcript" : "summary" })}
          onDownload={(format) => void download(format)}
        />
      </ShellLayoutBoundary>
    );
  },
  { properties: { routeSearch: { default: "", attribute: false } } },
);
