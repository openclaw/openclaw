import {
  createMemo,
  createSignal,
  createStore,
  Errored,
  isPending,
  latest,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { nativeGatewaysCapability } from "../../../app/native-gateways.runtime.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import "../../../styles/chat/session-diff-mobile.css";
import "../../../styles/session-panel-rail.css";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import "../../../components/tooltip.ts";
import {
  expandSessionDiffGap,
  splitSessionDiffFileText,
  type SessionDiffGapDirection,
} from "../../../lib/chat/session-diff-gaps.ts";
import {
  createDiffPairingBudget,
  pairSessionDiffLines,
} from "../../../lib/chat/session-diff-split.ts";
import { parseSessionDiffPatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../../../lib/reactive/visible-poll.ts";
import type { DiffPresentation } from "./chat-diff-render.solid.tsx";
import type { SessionDiffScope, SessionDiffProps } from "./chat-sidebar-content-types.ts";
import {
  SessionDiffMenu,
  type SessionDiffMenuAction,
  type SessionDiffDesktopMenuAction,
  type SessionDiffMenuData,
  type SessionDiffMenuDraft,
} from "./session-diff-menus.tsx";
import {
  loadSessionDiffPreferences,
  saveSessionDiffPreferences,
  type SessionDiffMode,
} from "./session-diff-preferences.ts";
import type { SessionDiffViewBindings } from "./session-diff-presentation.ts";
import { createSessionDiffPanelFrame, SessionDiffNativeGaps } from "./session-diff-result-view.tsx";
import { SessionDiffSyncMobile } from "./session-diff-sync-mobile.tsx";
import type { DiffValue, FileSource, FileView } from "./session-diff-types.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

const shellArgument = (value: string) =>
  /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export function SessionDiffPanel(props: SessionDiffProps) {
  const desktop = () => props.mobile === false;
  const mobile = () => props.mobile === true;
  const preferences = loadSessionDiffPreferences();
  const [value, setValue] = createSignal<DiffValue | null>(null);
  const collapseEntry = createMemo(
    () => ({
      desktop: desktop(),
      active: desktop() && props.active !== false,
      paths: value()?.views.map((view) => view.file.path) ?? [],
    }),
    {
      equals: (before, after) => before.desktop === after.desktop && before.active === after.active,
    },
  );
  // Desktop entry resets disclosure; native activity and data refreshes retain local choices.
  const [collapsedFiles, setCollapsedFiles] = createStore<Record<string, true>>(
    (draft: Record<string, true>) => {
      const entry = collapseEntry();
      return entry.desktop && !entry.active
        ? draft
        : Object.fromEntries<true>(
            (entry.desktop ? entry.paths : []).map((path) => [`file:${path}`, true]),
          );
    },
    Object.create(null),
  );
  // Prefix Git paths because Solid reserves prototype-related object keys.
  const isCollapsed = (path: string) => collapsedFiles[`file:${path}`] === true;
  const [menu, setMenu] = createSignal<SessionDiffMenuData | null>(null);
  // Local scope choices survive until a new request from this owner arrives.
  const [scope, setScope] = createSignal<SessionDiffScope>((previous) => {
    const request = props.scopeRequest;
    const owner = props.owner;
    return request?.owner === owner ? request.scope : (previous ?? { scope: "all" });
  });
  const [split, setSplit] = createSignal(preferences.split);
  const [wrap, setWrap] = createSignal(preferences.wrap);
  // The approved mobile cards start wrapped; desktop keeps its saved preference.
  const [mobileWrap, setMobileWrap] = createSignal(true);
  const [mode, setMode] = createSignal<SessionDiffMode>(preferences.mode ?? "auto");
  const [wordDiffs, setWordDiffs] = createSignal(preferences.wordDiffs !== false);
  const [wide, setWide] = createSignal(false);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [treeOpen, setTreeOpen] = createSignal(false);
  const [treeSearchOpen, setTreeSearchOpen] = createSignal(false);
  const [treeQuery, setTreeQuery] = createSignal("");
  const [motionInstant, setMotionInstant] = createSignal(false);
  let treeSearch: HTMLInputElement | undefined;
  let treeSearchTrigger: HTMLButtonElement | undefined;
  const fileElements = new Map<string, HTMLElement>();
  const fileToggles = new Map<string, () => HTMLButtonElement | undefined>();
  const effectiveSplit = () =>
    desktop() ? mode() === "split" || (mode() === "auto" && wide()) : split();
  function savePreferences(next: Partial<typeof preferences>) {
    // Solid batches signal writes; persist the computed change before getters update.
    saveSessionDiffPreferences({
      split: split(),
      wrap: wrap(),
      mode: mode(),
      wordDiffs: wordDiffs(),
      ...next,
    });
  }
  const requestTarget = createMemo(
    () => ({ loader: props.loader, owner: props.owner, scope: scope() }),
    {
      equals: (before, after) =>
        before.loader === after.loader &&
        before.owner === after.owner &&
        before.scope === after.scope,
    },
  );
  const [reload, setReload] = createSignal<{
    target: ReturnType<typeof requestTarget>;
    result?: SessionsDiffResult;
  } | null>(null);
  const request = createMemo(() => ({
    target: requestTarget(),
    reload: reload(),
    result: Promise.withResolvers<{ error: unknown } | null>(),
    deferred: false,
  }));
  const [computing, setComputing] = createSignal(false);
  // The queued plain request can start even while its read parks a commit.
  const readiness = createMemo(() => {
    const initialRequest = request();
    let active = true;
    onCleanup(() => {
      active = false;
      initialRequest.result.resolve(null);
    });
    queueMicrotask(() => {
      void loadRequest(
        initialRequest,
        () => active,
        initialRequest.reload?.target === initialRequest.target,
      );
    });
    return initialRequest.result.promise;
  });
  const presentationScope = createMemo(
    () => ({ owner: props.owner, scope: scope(), available: Boolean(props.loader) }),
    {
      equals: (before, after) =>
        before.owner === after.owner &&
        before.scope === after.scope &&
        before.available === after.available,
    },
  );
  const awaitingDestination = () => {
    const destination = latest(presentationScope);
    // Compare the destination and accepted result in the same transition frame.
    const current = latest(value);
    return (
      destination.available &&
      (current?.owner !== destination.owner || current.scope !== destination.scope)
    );
  };
  // Observe the same receipt before first paint without suspending the controls.
  const readStatus = createMemo(() => request().result.promise, { loadingValue: undefined });
  const syncData = createMemo(() => {
    const current = value();
    const { root, branch } = current?.owner === props.owner ? current.result : {};
    return root && branch
      ? {
          root,
          branch,
          command: `git fetch ${shellArgument(root)} ${shellArgument(branch)} && git checkout FETCH_HEAD`,
        }
      : null;
  });
  const renderMobileSync = () => <SessionDiffSyncMobile data={syncData()} />;
  const [gapRevision, setGapRevision] = createSignal(0);
  const pairedRows = createMemo(() => {
    gapRevision();
    const budget = createDiffPairingBudget();
    return new Map(
      (value()?.views ?? [])
        .filter((view) => !isCollapsed(view.file.path))
        .map((view) => [view, pairSessionDiffLines(view.source.parsed?.lines ?? [], budget)]),
    );
  });
  const codePresentations = new Map<string, DiffPresentation>();
  const fileTextCache = new WeakMap<FileSource, Promise<string[] | null>>();
  const unavailableFileText = new WeakSet<FileSource>();
  const expandingGaps = new WeakSet<DiffLine>();
  let disposed = false;
  const nativeGateways = nativeGatewaysCapability();
  onSettled(() => {
    // Dismiss the menu at native-owner replacement before another menu action can run.
    const unsubscribe = nativeGateways?.subscribe(() => setMenu(null));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  });

  useVisiblePoll(500, () => void loadRequest(latest(request)), {
    enabled: () => computing() && props.active !== false,
  });
  async function loadRequest(
    initialRequest: ReturnType<typeof request>,
    isActive: () => boolean = () => true,
    refresh = false,
  ) {
    const isCurrent = () => !disposed && isActive() && initialRequest === latest(request);
    if (!isCurrent()) {
      return;
    }
    const { target, reload: requestedReload, result: completion } = initialRequest;
    const { loader, owner, scope: requestedScope } = target;
    if (!loader) {
      setComputing(false);
      setValue(null);
      completion.resolve(null);
      return;
    }
    if (latest(() => props.active) === false || document.visibilityState === "hidden") {
      setComputing(true);
      // Deferred background reads must not hold the visible sibling's transition.
      initialRequest.deferred = true;
      completion.resolve(null);
      return;
    }
    if (initialRequest.deferred) {
      // Activation needs a fresh receipt so its result and errors remain observable.
      setReload({ target });
      return;
    }
    setComputing(false);
    let result: SessionsDiffResult | undefined;
    try {
      result =
        (requestedReload?.target === target ? requestedReload.result : undefined) ??
        (await (refresh ? loader(target.scope, { refresh: true }) : loader(target.scope)));
      if (!isCurrent()) {
        return;
      }
      if (result.computing) {
        setComputing(true);
        return;
      }
      const previous = value();
      const reusable =
        previous?.owner === owner &&
        JSON.stringify(previous.scope) === JSON.stringify(requestedScope)
          ? previous.views
          : [];
      const views = result.files.map((file) => ({
        file,
        // Retain source/presentation identity, never an old metadata snapshot.
        source: reusable.find(
          (view) =>
            view.file.path === file.path &&
            view.file.oldPath === file.oldPath &&
            view.file.patch === file.patch &&
            view.file.binary === file.binary &&
            view.file.truncated === file.truncated,
        )?.source ?? {
          parsed: file.patch
            ? parseSessionDiffPatch(file.patch, (count) =>
                t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
              )
            : null,
        },
      }));
      setValue({ owner, scope: requestedScope, result, views });
      props.onResult?.({ owner, scope: requestedScope, result });
      const currentPaths = new Set(views.map((view) => view.file.path));
      setCollapsedFiles((paths) => {
        for (const key of Object.keys(paths)) {
          if (!currentPaths.has(key.slice("file:".length))) {
            delete paths[key];
          }
        }
        for (const view of desktop() ? views : []) {
          if (!reusable.some((old) => old.file.path === view.file.path)) {
            paths[`file:${view.file.path}`] = true;
          }
        }
      });
      if (!currentPaths.has(selectedPath() ?? "")) {
        setSelectedPath(null);
      }
    } catch (error) {
      if (isCurrent()) {
        completion.resolve({ error });
      }
    } finally {
      if (isCurrent() && !result?.computing) {
        completion.resolve(null);
      }
    }
  }
  const loadDiff = () => setReload({ target: requestTarget() });
  function jumpToFile(path: string) {
    setMotionInstant(true);
    setSelectedPath(path);
    setCollapsedFiles((paths) => {
      delete paths[`file:${path}`];
    });
    // Scrolling needs the expanded file's committed height, and menu return-focus
    // must settle before focus moves to the selected file.
    onSettled(() => {
      fileElements.get(path)?.scrollIntoView({ block: "start" });
      fileToggles.get(path)?.()?.focus({ preventScroll: true });
    });
  }
  function toggleFile(path: string) {
    const collapsing = !isCollapsed(path);
    const element = fileElements.get(path);
    const readingAbove =
      collapsing &&
      element &&
      element.getBoundingClientRect().top <
        (element.parentElement?.getBoundingClientRect().top ?? 0);
    setCollapsedFiles((paths) => {
      const key = `file:${path}`;
      if (paths[key]) {
        delete paths[key];
      } else {
        paths[key] = true;
      }
    });
    if (readingAbove) {
      onSettled(() => {
        element.scrollIntoView({ block: "start" });
      });
    }
  }
  const collapseAll = () =>
    setCollapsedFiles(() =>
      Object.fromEntries<true>(
        (value()?.views ?? []).map(({ file }) => [`file:${file.path}`, true]),
      ),
    );
  function toggleTree() {
    const next = !treeOpen();
    setTreeOpen(next);
    if (!next) {
      setTreeSearchOpen(false);
      setTreeQuery("");
    }
  }
  function searchTree() {
    setTreeOpen(true);
    setTreeSearchOpen(true);
    onSettled(() => treeSearch?.focus());
  }
  function openAnchoredMenu(
    event: Event,
    draft: SessionDiffMenuDraft,
    placement: "bottom-end" | "bottom-start" | "top-start" = "bottom-end",
  ) {
    event.stopPropagation();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    setMenu({
      ...draft,
      ...(draft.kind === "scope" ? { placement } : {}),
      trigger,
    });
  }
  function handleMenuAction(action: SessionDiffMenuAction | SessionDiffDesktopMenuAction) {
    switch (action.kind) {
      case "toggle-file":
        toggleFile(action.path);
        return;
      case "collapse-code":
      case "collapse-functions":
        codePresentations.get(action.path)?.collapse(action.kind === "collapse-functions");
        return;
      case "expand-code":
        codePresentations.get(action.path)?.expand();
        return;
      case "collapse-all":
        collapseAll();
        return;
      case "expand-all":
        setCollapsedFiles(() => Object.create(null));
        return;
      case "toggle-wrap": {
        if (mobile()) {
          setMobileWrap((current) => !current);
          return;
        }
        const next = !wrap();
        setWrap(next);
        savePreferences({ wrap: next });
        return;
      }
      case "toggle-split": {
        const next = !split();
        setSplit(next);
        savePreferences({ split: next });
        return;
      }
      case "mode":
        setMode(action.value);
        savePreferences({ mode: action.value });
        return;
      case "toggle-word-diffs": {
        const next = !wordDiffs();
        setWordDiffs(next);
        savePreferences({ wordDiffs: next });
        return;
      }
      case "jump":
        jumpToFile(action.path);
        return;
      case "open-file-view":
        props.openFileView?.(action.path, action.view);
        return;
      case "sync": {
        if (mobile()) {
          if (syncData() && props.onOpenMobilePage) {
            props.onOpenMobilePage(
              {
                key: "session-diff-sync",
                title: t("chat.sessionDiff.syncLocally"),
                render: renderMobileSync,
              },
              action.trigger,
            );
          }
          return;
        }
        setMenu({ kind: "sync", ...action.data, trigger: action.trigger });
        return;
      }
      case "scope":
        if (JSON.stringify(action.value) !== JSON.stringify(scope())) {
          setScope(action.value);
        }
        return;
      case "open-file":
        void props.openFile?.(action.path);
        return;
      case "reveal-file":
        props.revealFile?.(action.path);
        return;
      case "open-editor":
        openEditor(action.editor, action.path);
    }
  }
  function canExpandGaps(view: FileView) {
    gapRevision();
    return (
      scope().scope !== "commit" &&
      Boolean(props.loadFileText) &&
      view.file.binary !== true &&
      view.source.parsed !== null &&
      !view.source.parsed.truncated &&
      !unavailableFileText.has(view.source)
    );
  }
  function loadFileLines(view: FileView) {
    const cached = fileTextCache.get(view.source);
    if (cached) {
      return cached;
    }
    const load = props.loadFileText;
    const result = load
      ? load(view.file.path)
          .then((text) => (text === null ? null : splitSessionDiffFileText(text)))
          .catch(() => null)
      : Promise.resolve(null);
    fileTextCache.set(view.source, result);
    return result;
  }
  async function expandGap(view: FileView, line: DiffLine, direction: SessionDiffGapDirection) {
    const parsed = view.source.parsed;
    const loader = props.loader;
    if (!parsed || !line.gap || !loader || !canExpandGaps(view) || expandingGaps.has(line)) {
      return;
    }
    expandingGaps.add(line);
    try {
      const requestedScope = scope();
      const currentRequest = request();
      const isCurrent = () =>
        !disposed && request() === currentRequest && Boolean(value()?.views.includes(view));
      let freshResult: SessionsDiffResult;
      try {
        freshResult = await loader(requestedScope, { refresh: true });
      } catch {
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (freshResult.computing) {
        loadDiff();
        return;
      }
      const freshFile = freshResult.files.find((file) => file.path === view.file.path);
      // Revalidate the patch: gap-interior edits cannot be detected from visible rows.
      // The remaining diff-to-file fetch race is accepted without shared snapshot identity.
      if (!freshFile || freshFile.patch !== view.file.patch) {
        fileTextCache.delete(view.source);
        setReload({ target: requestTarget(), result: freshResult });
        return;
      }
      const fileLines = await loadFileLines(view);
      if (!isCurrent() || !parsed.lines.includes(line) || view.source.expandedGaps?.has(line)) {
        return;
      }
      const expanded =
        fileLines &&
        expandSessionDiffGap(parsed.lines, line.gap, fileLines, direction, (count) =>
          t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
        );
      if (expanded) {
        if (desktop()) {
          const before = new Set(parsed.lines);
          const inserted = new Set(expanded.filter((entry) => !before.has(entry)));
          const index = parsed.lines.indexOf(line);
          view.source.expandedGaps ??= new Map();
          view.source.expandedGaps.set(line, inserted);
          // Keep the disclosure marker and original line identities; code folds
          // and other expanded gaps retain their owners when this region closes.
          parsed.lines = [...expanded.slice(0, index), line, ...expanded.slice(index)];
        } else {
          parsed.lines = expanded;
        }
      } else {
        unavailableFileText.add(view.source);
      }
      setGapRevision((revision) => revision + 1);
    } finally {
      expandingGaps.delete(line);
    }
  }
  function scopeTitle(result?: SessionsDiffResult) {
    const currentScope = scope();
    if (currentScope.scope === "uncommitted") {
      return t("chat.sessionDiff.uncommitted");
    }
    if (currentScope.scope === "commit") {
      const commit = result?.commits?.find((entry) => entry.sha === currentScope.commit);
      return commit ? `${commit.sha} ${commit.subject}` : currentScope.commit;
    }
    return t("chat.sessionDiff.allChanges");
  }
  function collapseGap(view: FileView, line: DiffLine) {
    const inserted = view.source.expandedGaps?.get(line);
    const source = view.source;
    if (inserted && source.parsed) {
      source.parsed.lines = source.parsed.lines.filter((entry) => !inserted.has(entry));
      source.expandedGaps?.delete(line);
      setGapRevision((revision) => revision + 1);
    }
  }
  function registerPresentation(path: string, presentation: DiffPresentation) {
    codePresentations.set(path, presentation);
    return () => {
      fileElements.delete(path);
      fileToggles.delete(path);
      if (codePresentations.get(path) === presentation) {
        codePresentations.delete(path);
      }
    };
  }
  const viewBindings: SessionDiffViewBindings = {
    loading: () =>
      isPending(readStatus) ||
      (latest(readStatus) === undefined
        ? Boolean(props.loader)
        : latest(readStatus) === null && awaitingDestination()),
    props,
    desktop,
    mobile,
    collapsedFiles,
    isCollapsed,
    scope,
    split,
    wrap,
    mobileWrap,
    mode,
    wordDiffs,
    selectedPath,
    treeOpen,
    treeSearchOpen,
    treeQuery,
    motionInstant,
    value,
    syncData,
    gapRevision,
    pairedRows,
    effectiveSplit,
    toggleFile,
    toggleTree,
    searchTree,
    jumpToFile,
    openAnchoredMenu,
    handleMenuAction,
    scopeTitle,
    loadDiff,
    expandGap,
    canExpandGaps,
    collapseGap,
    registerPresentation,
    registerFileElement: (path, element, toggle) => {
      fileElements.set(path, element);
      fileToggles.set(path, toggle);
    },
    setTreeSearch: (element) => {
      treeSearch = element;
    },
    setTreeSearchTrigger: (element) => {
      treeSearchTrigger = element;
    },
    setTreeQuery,
    setWide,
    closeTreeSearch: () => {
      setTreeQuery("");
      setTreeSearchOpen(false);
      onSettled(() => {
        treeSearchTrigger?.focus({ preventScroll: true });
      });
    },
    refreshCollapsed: () => {
      collapseAll();
      loadDiff();
    },
    renderMobileSync,
  };
  const { Panel, Result } = createSessionDiffPanelFrame(
    viewBindings,
    setMotionInstant,
    awaitingDestination,
  );
  const raiseReadFailure = (error: unknown): never => {
    throw error;
  };
  return (
    <openclaw-session-diff>
      <Show when={!desktop()}>
        <SessionDiffNativeGaps
          value={value}
          refresh={() => setGapRevision((revision) => revision + 1)}
        />
      </Show>
      <Panel>
        <Loading
          on={latest(presentationScope)}
          fallback={
            <Show when={props.loader}>
              <PanelLoadingSkeleton variant="review" label={t("chat.sessionDiff.loading")} />
            </Show>
          }
        >
          <Show when={isPending(readiness) ? null : latest(readiness)} fallback={<Result />}>
            {(failed) => (
              <Errored
                fallback={(error, reset) => (
                  <div class="callout danger">
                    {formatUiError(error())}
                    <Show when={mobile()}>
                      <button
                        class="btn btn--ghost"
                        type="button"
                        disabled={!props.loader}
                        onClick={() => {
                          loadDiff();
                          reset();
                        }}
                      >
                        <Icon name="refresh" />
                        {t("common.retry")}
                      </button>
                    </Show>
                  </div>
                )}
              >
                {raiseReadFailure(failed().error)}
              </Errored>
            )}
          </Show>
        </Loading>
      </Panel>
      <Show when={menu()} keyed>
        {(current) => (
          <SessionDiffMenu
            menu={current}
            onAction={handleMenuAction}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </openclaw-session-diff>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-session-diff": HTMLAttributes<HTMLElement>;
    }
  }
}
