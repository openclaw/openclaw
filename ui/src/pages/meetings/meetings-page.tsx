import "./meetings.css";
import type {
  TranscriptsExportParams,
  TranscriptsExportResult,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { createLoadingBoundary } from "@solidjs/signals";
import {
  action,
  createEffect,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  isPending,
  latest,
  onCleanup,
  onSettled,
} from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { SETTINGS_SEARCH_TARGETS } from "../config/settings-targets.ts";
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
// Cancellation settles presentation even when the retired RPC replies later.
type Operation = {
  abort: AbortController;
  completion: ReturnType<typeof Promise.withResolvers<void>>;
};
// Requests stay synchronous; Solid observes the already-admitted completion.
function createArchiveRead(run: (signal: AbortSignal, search?: string) => Promise<void>) {
  const [receipt, setReceipt] = createSignal<Promise<void> | null>(null, { ownedWrite: true });
  const read = createMemo(() => receipt());
  // Attribute consumers need a local fallback too, without suspending the page chrome.
  const loading = createLoadingBoundary(
    () => isPending(read),
    () => true,
  );
  const request = createPageRequest(() => {}, {
    task: (search: string | undefined, { signal }) => run(signal, search),
    onComplete: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  const cancel = () => {
    request.reset();
    setReceipt(null);
  };
  onCleanup(request.cancel);
  return {
    get pending() {
      return request.pending;
    },
    read,
    loading,
    abort: cancel,
    run(search?: string) {
      const completion = request.run(search);
      // Inactive tabs may not consume their read until later; the memo owns visible errors.
      void completion.catch(() => {});
      void setReceipt(completion);
      return completion;
    },
  };
}

export function MeetingsPage(props: { routeSearch?: string }) {
  // Navigation can advance while a presentation action awaits its admitted request.
  const routeSearch = () => latest(() => props.routeSearch ?? "");
  const context = useApplication();
  const projection = projectGateway(context.gateway);
  const gateway = createGatewayConnectionLifecycle(context.gateway.snapshot);
  let active = true;
  const [drafts, setDrafts] = createStore<Record<string, string>>({});
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
  let summaryAttempted = false;
  const [summaryCompletion, setSummaryCompletion] = createSignal<Promise<void> | null>(null, {
    ownedWrite: true,
  });
  const summaryCompleted = createMemo(() => summaryCompletion()?.then(() => true) ?? false);
  let summaryOperation: Operation | null = null;
  const [generating, setGenerating] = createOptimistic(false);
  const presentSummary = action(function* (completion: Promise<void>) {
    setGenerating(true);
    yield completion.catch(() => {});
  });
  const [readerPages, setReaderPages] = createStore<TranscriptsGetResult[]>([]);
  const [exportCompletion, setExportCompletion] = createSignal<Promise<void> | null>(null, {
    ownedWrite: true,
  });
  const exportCompleted = createMemo(() => exportCompletion()?.then(() => true) ?? false);
  let exportOperation: Operation | null = null;
  const [exporting, setExporting] = createOptimistic(false);
  const presentExport = action(function* (completion: Promise<void>) {
    setExporting(true);
    yield completion.catch(() => {});
  });
  let focusSelection = false;
  const focusTargets: Partial<Record<"search" | "reader-title" | "reader-error", HTMLElement>> = {};
  const focusCurrentTarget = () => {
    if (!active || !focusSelection) {
      return;
    }
    const target = selection().selector
      ? [focusTargets["reader-error"], focusTargets["reader-title"]].find(
          (element) => element?.isConnected,
        )
      : focusTargets.search;
    if (target?.isConnected) {
      target.focus();
      focusSelection = false;
    }
  };

  const listTask = createArchiveRead(async (signal, search = routeSearch()) => {
    const client = requestClient();
    if (!client) {
      return;
    }
    const params = transcriptListParams(search);
    const selector = selection(search).selector;
    await readArchive({
      client,
      method: "transcripts.list",
      params,
      signal,
      current: () =>
        selection().selector === selector &&
        JSON.stringify(transcriptListParams(routeSearch())) === JSON.stringify(params),
      accept: (result) => {
        setListDenial(null);
        setList(result);
      },
    });
  });
  const summaryTask = createArchiveRead(async (signal, search = routeSearch()) => {
    const client = requestClient();
    const selector = selection(search).selector;
    if (!client || !selector) {
      return;
    }
    await readArchive({
      client,
      method: "transcripts.get",
      params: { selector },
      signal,
      current: () => selection().selector === selector,
      accept: (result, current) => {
        setReaderDenial(null);
        setSummary(result);
        onSettled(() => {
          focusCurrentTarget();
          if (current()) {
            void generateMissingSummary(false, result);
          }
        });
      },
    });
  });
  const readerTask = createArchiveRead(async (signal, search = routeSearch()) => {
    const client = requestClient();
    const { selector, query } = selection(search);
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
        selection().selector === selector && selection().query === query && readerCursor === cursor,
      accept: (result, current) => {
        setReaderDenial(null);
        // A background read replaces the current page; only forward paging appends.
        setReaderPages((pages) => {
          if (!cursor) {
            pages.length = 0;
          } else if (cursor === loadedReaderCursor) {
            pages.pop();
          }
          pages.push(result);
        });
        loadedReaderCursor = cursor;
        onSettled(focusCurrentTarget);
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

  function selection(search = routeSearch()) {
    const query = new URLSearchParams(search);
    return {
      selector: query.get("selector") ?? "",
      query: (query.get("find") ?? "").slice(0, TRANSCRIPT_QUERY_LIMIT),
    };
  }

  function readerTab(): "text" | "summary" {
    const params = new URLSearchParams(routeSearch());
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
    const current = () => !request.signal.aborted && requestScope.isCurrent() && request.current();
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
        setReaderPages((pages) => {
          pages.length = 0;
        });
        cancelExport();
        onSettled(focusCurrentTarget);
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
    setReaderPages((pages) => {
      pages.length = 0;
    });
  }

  function cancelExport() {
    const previous = exportOperation;
    exportOperation = null;
    previous?.abort.abort();
    previous?.completion.resolve();
    setExportCompletion(null);
  }

  function cancelSummaryGeneration() {
    const previous = summaryOperation;
    summaryOperation = null;
    previous?.abort.abort();
    previous?.completion.resolve();
    summaryAttempted = false;
    setSummaryCompletion(null);
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
      summaryOperation !== null ||
      (!retry && summaryAttempted)
    ) {
      return;
    }
    const operation = {
      abort: new AbortController(),
      completion: Promise.withResolvers<void>(),
    };
    summaryOperation = operation;
    summaryAttempted = true;
    void setSummaryCompletion(operation.completion.promise);
    // A hidden or retired summary may never consume its error boundary.
    void operation.completion.promise.catch(() => {});
    const current = () =>
      !operation.abort.signal.aborted &&
      summaryOperation === operation &&
      requestScope.isCurrent() &&
      selection().selector === selector;
    // Live authority and result publication stay outside the action's held snapshot.
    const completed = (async () => {
      try {
        const result = await client.request<TranscriptsGetResult>(
          "transcripts.summarize",
          { selector },
          {
            signal: operation.abort.signal,
            // Allow the shared summary lane to drain an earlier generation before inference.
            timeoutMs: 120000,
          },
        );
        if (!current()) {
          return;
        }
        summaryTask.abort();
        setSummary(result);
      } catch (error) {
        if (current()) {
          operation.completion.reject(error);
        }
      } finally {
        if (summaryOperation === operation) {
          summaryOperation = null;
        }
        operation.completion.resolve();
      }
    })();
    await Promise.resolve();
    return current() ? presentSummary(operation.completion.promise) : completed;
  }

  function navigate(patch: Record<string, string | null>) {
    // Clear/submit must also synchronize when the URL value was already equal.
    setDrafts((draft) => {
      for (const [key, value] of Object.entries(patch)) {
        draft[key] = value ?? "";
      }
    });
    context.navigate("meetings", {
      search: transcriptRouteSearch(routeSearch(), patch),
    });
  }

  function refresh() {
    cancelExport();
    setSummary(null);
    resetReader();
    // A refresh starts a new cursor snapshot, rather than reusing an old list page.
    if (new URLSearchParams(routeSearch()).has("cursor")) {
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
    const session = summary()?.session ?? readerPages.at(-1)?.session;
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
    if (!client || !selector || exportOperation !== null) {
      return;
    }
    const operation = {
      abort: new AbortController(),
      completion: Promise.withResolvers<void>(),
    };
    exportOperation = operation;
    void setExportCompletion(operation.completion.promise);
    // The error boundary owns feedback, including after the action has settled.
    void operation.completion.promise.catch(() => {});
    const current = () => exportOperation === operation && !operation.abort.signal.aborted;
    const completed = (async () => {
      try {
        await readArchive({
          client,
          method: "transcripts.export",
          params: { selector, format },
          signal: operation.abort.signal,
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
            } finally {
              anchor.remove();
              // Allow the browser to consume the object URL before releasing the bytes.
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
          },
        });
      } catch (error) {
        if (current()) {
          operation.completion.reject(error);
        }
      } finally {
        if (exportOperation === operation) {
          exportOperation = null;
        }
        operation.completion.resolve();
      }
    })();
    // Let input drafts settle before opening the presentation transaction.
    await Promise.resolve();
    return current() ? presentExport(operation.completion.promise) : completed;
  }

  let previousSearch: string | undefined;
  let previousListParams: string | undefined;
  let connectionHello: unknown;
  let connectionAuth: unknown;
  createEffect(
    () => ({ snapshot: projection.read().snapshot, search: routeSearch() }),
    ({ snapshot, search }) => {
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
        setDrafts((draft) => {
          for (const key of [...TRANSCRIPT_FILTER_KEYS, "find"]) {
            if (
              previous.get(key) !== next.get(key) ||
              previousSearch === undefined ||
              (key === "find" && selectorChanged)
            ) {
              draft[key] = next.get(key) ?? "";
            }
          }
        });
      }
      if (selectorChanged || queryChanged) {
        resetReader();
        cancelExport();
        focusSelection = previousSearch !== undefined;
      }
      if (connectionChanged || authorizationChanged || filtersChanged || selectorChanged) {
        void listTask.run(search);
      }
      if (connectionChanged || authorizationChanged || selectorChanged) {
        void summaryTask.run(search);
      }
      if (connectionChanged || authorizationChanged || selectorChanged || queryChanged) {
        void readerTask.run(search);
      }
      previousSearch = search;
      previousListParams = listParams;
      onSettled(focusCurrentTarget);
    },
  );
  onSettled(() => {
    const timer = globalThis.setInterval(() => refreshLive(), 3_000);
    const activate = () => refreshLive(true);
    const stopVisibility = listen(document, "visibilitychange", activate);
    const stopFocus = listen(globalThis, "focus", activate);
    return () => {
      stopVisibility();
      stopFocus();
      active = false;
      gateway.dispose();
      cancelSummaryGeneration();
      cancelExport();
      globalThis.clearInterval(timer);
    };
  });

  const activeReaderTask = () => (readerTab() === "summary" ? summaryTask : readerTask);
  return (
    <openclaw-meetings-page>
      <TranscriptsView
        onFocusTarget={(kind, element) => {
          focusTargets[kind] = element;
          focusCurrentTarget();
          return () => {
            if (focusTargets[kind] === element) {
              delete focusTargets[kind];
            }
          };
        }}
        basePath={context.basePath}
        now={now()}
        search={routeSearch()}
        drafts={drafts}
        onDraft={(key, value) =>
          setDrafts((draft) => {
            draft[key] = value;
          })
        }
        connected={projection.read().snapshot.phase === "connected"}
        allowed={hasOperatorReadAccess(projection.read().snapshot.hello?.auth ?? null)}
        list={requestClient() ? list() : null}
        listRead={listTask.read}
        listLoading={!listDenial() && listTask.loading()}
        listError={listDenial()}
        reader={{
          get summary() {
            return summary();
          },
          get pages() {
            return readerPages;
          },
          read: () => activeReaderTask().read(),
          get loading() {
            return activeReaderTask().loading();
          },
          get error() {
            return readerDenial();
          },
        }}
        readerTab={readerTab()}
        summaryGenerating={generating()}
        summaryCompletion={summaryCompletion()}
        summaryRead={summaryCompleted}
        onSummaryRetry={() => void generateMissingSummary(true)}
        exporting={exporting()}
        exportCompletion={exportCompletion()}
        exportRead={exportCompleted}
        onNavigate={navigate}
        onOpenCaptureSettings={() => {
          const target = SETTINGS_SEARCH_TARGETS.meetingCapture;
          context.navigate(target.routeId, { search: target.search, hash: target.hash });
        }}
        onRefresh={refresh}
        onReaderRetry={() => {
          if (!readerPages.length) {
            resetReader();
          }
          if (readerTab() === "summary") {
            void summaryTask.run();
            return;
          }
          if (!summary()) {
            void summaryTask.run();
          }
          void readerTask.run();
        }}
        onReaderTab={(tab) => navigate({ tab: tab === "text" ? "transcript" : "summary" })}
        onDownload={(format) => void download(format)}
      />
    </openclaw-meetings-page>
  );
}
