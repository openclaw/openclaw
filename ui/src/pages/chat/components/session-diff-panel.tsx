import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { nativeGatewaysCapability } from "../../../app/native-gateways.runtime.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
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
import { parseSessionDiffPatch, type ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createDiffPresentation, type DiffPresentation } from "./chat-diff-render.solid.tsx";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import {
  SessionDiffMenu,
  type SessionDiffMenuAction,
  type SessionDiffMenuData,
  type SessionDiffMenuDraft,
  type SessionDiffScope,
} from "./session-diff-menus.tsx";
import {
  loadSessionDiffPreferences,
  saveSessionDiffPreferences,
} from "./session-diff-preferences.ts";
import { SessionDiffFileBody } from "./session-diff-render.tsx";

export type SessionDiffLoader = (params: SessionDiffScope) => Promise<SessionsDiffResult>;
export type SessionDiffFileTextLoader = (path: string) => Promise<string | null>;
export type SessionDiffOwner = { agentId: string; sessionKey: string };
type SessionDiffProps = {
  owner: SessionDiffOwner | null;
  execNode: string | null;
  loader: SessionDiffLoader | null;
  loadFileText: SessionDiffFileTextLoader | null;
  openFile: ((path: string) => void) | null;
  revealFile: ((path: string) => void) | null;
};
type FileSource = { parsed: ParsedFilePatch | null };
type FileView = { file: SessionDiffFile; source: FileSource };
type DiffValue = {
  owner: SessionDiffOwner | null;
  scope: SessionDiffScope;
  result: SessionsDiffResult;
  views: FileView[];
};
const FILE_STATUS_LABELS = {
  added: ["A", "chat.sessionDiff.statusAdded"],
  deleted: ["D", "chat.sessionDiff.statusDeleted"],
  renamed: ["R", "chat.sessionDiff.statusRenamed"],
  modified: ["M", "chat.sessionDiff.statusModified"],
} as const;
function diffStat(file: Pick<SessionDiffFile, "additions" | "deletions">) {
  const modified = Math.min(file.additions, file.deletions);
  return { added: file.additions - modified, removed: file.deletions - modified, modified };
}
function totalDiffStat(files: readonly SessionDiffFile[]) {
  const total = { added: 0, removed: 0, modified: 0 };
  for (const file of files) {
    const stat = diffStat(file);
    total.added += stat.added;
    total.removed += stat.removed;
    total.modified += stat.modified;
  }
  return total;
}
function splitPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: normalized }
    : { directory: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}
function shellArgument(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function SessionDiffPanel(props: SessionDiffProps) {
  const preferences = loadSessionDiffPreferences();
  const [menu, setMenu] = createSignal<SessionDiffMenuData | null>(null);
  const [scope, setScope] = createSignal<SessionDiffScope>({ scope: "all" });
  const [split, setSplit] = createSignal(preferences.split);
  const [wrap, setWrap] = createSignal(preferences.wrap);
  const [gapRevision, setGapRevision] = createSignal(0);
  const requestTarget = createMemo(() => ({
    loader: props.loader,
    owner: props.owner,
    scope: scope(),
  }));
  const [reload, setReload] = createSignal<{
    target: ReturnType<typeof requestTarget>;
    result?: SessionsDiffResult;
  } | null>(null);
  const request = createMemo(() => ({ target: requestTarget(), reload: reload() }));
  const [value, setValue] = createSignal<DiffValue | null>(null);
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<{ error: unknown } | null>(null);
  function RequestLifetime(requestProps: { request: ReturnType<typeof request> }) {
    onSettled(() => {
      const { target, reload: requestedReload } = requestProps.request;
      const { loader, owner, scope: requestedScope } = target;
      setFailure(null);
      if (!loader) {
        setValue(null);
        setPending(false);
        return undefined;
      }
      let active = true;
      setPending(true);
      void (async () => {
        try {
          const result =
            (requestedReload?.target === target ? requestedReload.result : undefined) ??
            (await loader(target.scope));
          if (!active) {
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
        } catch (error) {
          if (active) {
            setFailure({ error });
          }
        } finally {
          if (active) {
            setPending(false);
          }
        }
      })();
      return () => {
        active = false;
      };
    });
    return null;
  }
  const loading = () => props.loader !== null && pending();
  const [collapsedPaths, setCollapsedPaths] = createSignal<Set<string>>((previous) => {
    const current = value();
    if (!current) {
      return previous ?? new Set();
    }
    const paths = new Set(current.views.map((view) => view.file.path));
    return new Set([...(previous ?? [])].filter((path) => paths.has(path)));
  });
  const pairedRows = createMemo(() => {
    gapRevision();
    const budget = createDiffPairingBudget();
    return new Map(
      (value()?.views ?? [])
        .filter((view) => !collapsedPaths().has(view.file.path))
        .map((view) => [view, pairSessionDiffLines(view.source.parsed?.lines ?? [], budget)]),
    );
  });
  const codePresentations = new Map<string, DiffPresentation>();
  const fileTextCache = new WeakMap<FileSource, Promise<string[] | null>>();
  const unavailableFileText = new WeakSet<FileSource>();
  let disposed = false;
  const nativeGateways = nativeGatewaysCapability();
  // Dismiss the menu at native-owner replacement before another menu action can run.
  const unsubscribe = nativeGateways?.subscribe(() => setMenu(null));
  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
  });
  function toggleFile(path: string) {
    setCollapsedPaths((paths) => {
      const next = new Set(paths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
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
    const bounds = trigger.getBoundingClientRect();
    setMenu({
      ...draft,
      ...(draft.kind === "scope" && placement !== "bottom-end" ? { placement } : {}),
      anchor: {
        x: placement.endsWith("start") ? bounds.left : bounds.right,
        y: placement.startsWith("top") ? bounds.top : bounds.bottom,
      },
      trigger,
    });
  }
  function handleMenuAction(action: SessionDiffMenuAction) {
    switch (action.kind) {
      case "collapse-code":
      case "collapse-functions":
        codePresentations.get(action.path)?.collapse(action.kind === "collapse-functions");
        return;
      case "expand-code":
        codePresentations.get(action.path)?.expand();
        return;
      case "collapse-all":
        setCollapsedPaths(new Set(value()?.views.map((view) => view.file.path) ?? []));
        return;
      case "expand-all":
        setCollapsedPaths(new Set<string>());
        return;
      case "toggle-wrap": {
        const next = !wrap();
        setWrap(next);
        saveSessionDiffPreferences({ split: split(), wrap: next });
        return;
      }
      case "toggle-split": {
        const next = !split();
        setSplit(next);
        saveSessionDiffPreferences({ split: next, wrap: wrap() });
        return;
      }
      case "scope":
        if (JSON.stringify(action.value) !== JSON.stringify(scope())) {
          setScope(action.value);
        }
        return;
      case "open-file":
        props.openFile?.(action.path);
        return;
      case "reveal-file":
        props.revealFile?.(action.path);
        return;
      case "open-editor":
        openEditor(action.editor, action.path);
    }
  }
  function Summary(summary: { result: SessionsDiffResult }) {
    const branchLabel = () =>
      summary.result.baseRef &&
      summary.result.branch &&
      summary.result.baseRef !== summary.result.branch
        ? `${summary.result.baseRef} → ${summary.result.branch}`
        : (summary.result.branch ?? summary.result.baseRef ?? "");
    const syncCommand = () =>
      summary.result.root && summary.result.branch
        ? `git fetch ${shellArgument(summary.result.root)} ${shellArgument(summary.result.branch)} && git checkout FETCH_HEAD`
        : null;
    return (
      <div class="session-diff__summary">
        <span
          class="session-diff__branch"
          title={[branchLabel(), summary.result.root].filter(Boolean).join("\n")}
        >
          <Icon name="gitBranch" />
          <span class="session-diff__branch-label">{branchLabel()}</span>
        </span>
        {summary.result.unavailableReason !== "workspace_stopped" && (
          <DiffStatChips stat={totalDiffStat(summary.result.files)} />
        )}
        <span class="session-diff__summary-spacer" />
        <Show when={syncCommand()}>
          {(command) => (
            <button
              class="btn btn--ghost btn--sm session-diff__toolbar-button"
              type="button"
              onClick={(event) =>
                openAnchoredMenu(event, {
                  kind: "sync",
                  command: command(),
                  root: summary.result.root!,
                  branch: summary.result.branch!,
                })
              }
            >
              {t("chat.sessionDiff.sync")} <Icon name="chevronDown" />
            </button>
          )}
        </Show>
        <openclaw-tooltip prop:content={t("chat.sessionDiff.viewOptions")}>
          <button
            class="btn btn--ghost btn--icon session-diff__toolbar-icon"
            type="button"
            aria-label={t("chat.sessionDiff.viewOptions")}
            onClick={(event) =>
              openAnchoredMenu(event, { kind: "view", split: split(), wrap: wrap() })
            }
          >
            <Icon name="moreHorizontal" />
          </button>
        </openclaw-tooltip>
        <openclaw-tooltip prop:content={t("chat.sessionDiff.refresh")}>
          <button
            class="btn btn--ghost btn--icon session-diff__refresh"
            type="button"
            aria-label={t("chat.sessionDiff.refresh")}
            disabled={loading()}
            onClick={() => setReload({ target: requestTarget() })}
          >
            <Icon name="refresh" />
          </button>
        </openclaw-tooltip>
      </div>
    );
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
    if (!parsed || !line.gap || !loader || !canExpandGaps(view)) {
      return;
    }
    const requestedScope = scope();
    const currentRequest = request();
    const isCurrent = () =>
      !disposed && request() === currentRequest && Boolean(value()?.views.includes(view));
    let freshResult: SessionsDiffResult;
    try {
      freshResult = await loader(requestedScope);
    } catch {
      return;
    }
    if (!isCurrent()) {
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
    if (!isCurrent()) {
      return;
    }
    const expanded =
      fileLines &&
      expandSessionDiffGap(parsed.lines, line.gap, fileLines, direction, (count) =>
        t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
      );
    if (expanded) {
      parsed.lines = expanded;
    } else {
      unavailableFileText.add(view.source);
    }
    setGapRevision((revision) => revision + 1);
  }
  function Gap(gapProps: { view: FileView; line: DiffLine }): SolidJSX.Element {
    const gap = () => gapProps.line.gap;
    const chunkCount = () => (gap()!.count <= 25 ? gap()!.count : 20);
    return (
      <Show when={gap() && canExpandGaps(gapProps.view)} fallback={gapProps.line.text}>
        <span class="session-diff__gap-controls">
          <For
            each={
              [
                ["up", "expandPreviousLines"],
                ["all", "expandAllLines"],
                ["down", "expandNextLines"],
              ] as const
            }
          >
            {([direction, label]) => (
              <button
                class={{ "session-diff__gap-count": direction === "all" }}
                type="button"
                aria-label={t(`chat.sessionDiff.${label}`, {
                  count: String(direction === "all" ? gap()!.count : chunkCount()),
                })}
                onClick={() => void expandGap(gapProps.view, gapProps.line, direction)}
              >
                {direction === "all" ? (
                  gapProps.line.text
                ) : (
                  <Icon name={direction === "up" ? "chevronUp" : "chevronDown"} />
                )}
              </button>
            )}
          </For>
        </span>
      </Show>
    );
  }
  function File(fileProps: { view: FileView; result: SessionsDiffResult }) {
    // The keyed list retains this owner by source, not refreshed metadata.
    const initialSource = untrack(() => fileProps.view.source);
    const file = () => fileProps.view.file;
    const collapsed = () => collapsedPaths().has(file().path);
    const presentation = createDiffPresentation({
      get active() {
        return !collapsed();
      },
      get lines() {
        gapRevision();
        return initialSource.parsed?.lines ?? [];
      },
      get file() {
        return fileProps.view.file;
      },
      get rows() {
        return pairedRows().get(fileProps.view) ?? [];
      },
    });
    // A retained source has one immutable file path across metadata refreshes.
    const initialPath = untrack(() => fileProps.view.file.path);
    codePresentations.set(initialPath, presentation);
    onCleanup(() => {
      if (codePresentations.get(initialPath) === presentation) {
        codePresentations.delete(initialPath);
      }
    });
    const path = () => splitPath(file().path);
    const intrinsicSize = () => {
      gapRevision();
      return `auto ${Math.max(80, Math.min(12_000, (initialSource.parsed?.lines.length ?? 2) * 19))}px`;
    };
    const statusLabel = () => FILE_STATUS_LABELS[file().status] ?? FILE_STATUS_LABELS.modified;
    return (
      <section class="session-diff__file" data-status={file().status}>
        <presentation.SyntaxLifetime />
        <div class="session-diff__file-header">
          <button
            class="session-diff__file-toggle"
            type="button"
            aria-expanded={collapsed() ? "false" : "true"}
            title={file().oldPath ? `${file().oldPath} → ${file().path}` : file().path}
            onClick={() => toggleFile(file().path)}
          >
            <span
              class={["session-diff__chevron", { "session-diff__chevron--open": !collapsed() }]}
            >
              <Icon name="chevronRight" />
            </span>
            <span
              class={["session-diff__status", `session-diff__status--${file().status}`]}
              title={t(statusLabel()[1])}
            >
              {statusLabel()[0]}
            </span>
            <span class="session-diff__path">
              {file().oldPath && <span class="session-diff__old-path">{file().oldPath} →</span>}
              <span class="session-diff__filename">{path().name}</span>
              {path().directory && <span class="session-diff__directory">{path().directory}</span>}
            </span>
            {file().untracked === true && (
              <span class="session-diff__badge">{t("chat.sessionDiff.untracked")}</span>
            )}
            {fileProps.result.unavailableReason !== "workspace_stopped" && (
              <DiffStatChips stat={diffStat(file())} />
            )}
          </button>
          <button
            class="btn btn--ghost btn--icon session-diff__file-menu"
            type="button"
            aria-label={t("chat.sessionDiff.fileActions", { path: file().path })}
            onClick={(event) => {
              const absolutePath = fileProps.result.root
                ? localEditorFilePath(
                    { root: fileProps.result.root, path: file().path },
                    props.execNode,
                  )
                : null;
              openAnchoredMenu(event, {
                kind: "file",
                path: file().path,
                ...(absolutePath ? { absolutePath } : {}),
                canOpenFile: Boolean(props.openFile),
                canReveal: Boolean(props.revealFile),
              });
            }}
          >
            <Icon name="moreHorizontal" />
          </button>
        </div>
        <Show when={!collapsed()}>
          <div
            class="session-diff__file-body"
            style={{
              "contain-intrinsic-size": intrinsicSize(),
            }}
          >
            <SessionDiffFileBody
              file={file()}
              parsed={initialSource.parsed}
              unavailableReason={fileProps.result.unavailableReason}
              split={split()}
              presentation={presentation}
              renderSkip={(line) => <Gap view={fileProps.view} line={line} />}
            />
          </div>
        </Show>
      </section>
    );
  }
  function scopeTitle(result: SessionsDiffResult) {
    const currentScope = scope();
    if (currentScope.scope === "uncommitted") {
      return t("chat.sessionDiff.uncommitted");
    }
    if (currentScope.scope === "commit") {
      const commit = result.commits?.find((entry) => entry.sha === currentScope.commit);
      return commit ? `${commit.sha} ${commit.subject}` : currentScope.commit;
    }
    return t("chat.sessionDiff.allChanges");
  }
  function ResultBody(body: { value: DiffValue }) {
    const result = () => body.value.result;
    const footer = () =>
      result().aheadCount && result().baseRef
        ? t("chat.sessionDiff.commitsAhead", {
            count: String(result().aheadCount),
            base: result().baseRef!,
          })
        : (result().branch ?? result().baseRef ?? t("chat.sessionDiff.allChanges"));
    return (
      <>
        {result().unavailableReason === "not_git" ||
        result().unavailableReason === "unknown_session" ? (
          <div class="session-diff__note">
            {t(
              result().unavailableReason === "not_git"
                ? "chat.sessionDiff.notGit"
                : "chat.sessionDiff.unknownSession",
            )}
          </div>
        ) : (
          <>
            <Summary result={result()} />
            {result().unavailableReason === "workspace_stopped" && (
              <div class="session-diff__note">{t("chat.sessionDiff.workspaceStopped")}</div>
            )}
            <button
              class="session-diff__section-title"
              type="button"
              aria-label={t("chat.sessionDiff.scopeMenu")}
              onClick={(event) =>
                openAnchoredMenu(
                  event,
                  { kind: "scope", active: scope(), result: result() },
                  "bottom-start",
                )
              }
            >
              <span>{scopeTitle(result())}</span>
              <Icon name="chevronDown" />
            </button>
            <div class="session-diff__files">
              {result().unavailableReason === "unknown_commit" ? (
                <div class="session-diff__note">{t("chat.sessionDiff.unknownCommit")}</div>
              ) : (
                <For
                  each={body.value.views}
                  keyed={(view) => view.source}
                  fallback={
                    result().unavailableReason !== "workspace_stopped" &&
                    result().truncated !== true ? (
                      <div class="session-diff__note">{t("chat.sessionDiff.empty")}</div>
                    ) : null
                  }
                >
                  {(view) => <File view={view()} result={result()} />}
                </For>
              )}
              {result().truncated === true && (
                <div class="session-diff__note">{t("chat.sessionDiff.truncatedResult")}</div>
              )}
            </div>
            <button
              class="session-diff__footer"
              type="button"
              aria-label={t("chat.sessionDiff.scopeMenu")}
              onClick={(event) =>
                openAnchoredMenu(
                  event,
                  { kind: "scope", active: scope(), result: result() },
                  "top-start",
                )
              }
            >
              <span>{footer()}</span>
              <Icon name="chevronUp" />
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <openclaw-session-diff>
      <div
        class={["session-diff", { "session-diff--wrap": wrap() }]}
        aria-busy={loading() ? "true" : "false"}
      >
        <Show when={request()} keyed>
          {(current) => <RequestLifetime request={current} />}
        </Show>
        <Show
          when={failure()}
          fallback={
            <Show
              when={loading() && (value()?.owner !== props.owner || value()?.scope !== scope())}
              fallback={<Show when={value()}>{(current) => <ResultBody value={current()} />}</Show>}
            >
              <PanelLoadingSkeleton variant="review" label={t("chat.sessionDiff.loading")} />
            </Show>
          }
        >
          {(failed) => <div class="callout danger">{formatUiError(failed().error)}</div>}
        </Show>
        <Show when={menu()} keyed>
          {(current) => (
            <SessionDiffMenu
              menu={current}
              onAction={handleMenuAction}
              onClose={() => setMenu(null)}
            />
          )}
        </Show>
      </div>
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
