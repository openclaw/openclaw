import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  runWithOwner,
  Show,
  untrack,
} from "solid-js";
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
import { parseSessionDiffPatch, type ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { DiffBlock, DiffStatChips } from "./chat-diff-render.solid.tsx";
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
import { SessionSplitDiff } from "./session-diff-render.tsx";

export type SessionDiffLoader = (params: SessionDiffScope) => Promise<SessionsDiffResult>;
export type SessionDiffFileTextLoader = (path: string) => Promise<string | null>;
export type SessionDiffOwner = { agentId: string; sessionKey: string };
export type SessionDiffProps = {
  owner: SessionDiffOwner | null;
  execNode: string | null;
  loader: SessionDiffLoader | null;
  loadFileText: SessionDiffFileTextLoader | null;
  openFile: ((path: string) => void) | null;
  revealFile: ((path: string) => void) | null;
};
type FileView = { file: SessionDiffFile; parsed: ParsedFilePatch | null };
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
  return files.reduce(
    (total, file) => {
      const stat = diffStat(file);
      return {
        added: total.added + stat.added,
        removed: total.removed + stat.removed,
        modified: total.modified + stat.modified,
      };
    },
    { added: 0, removed: 0, modified: 0 },
  );
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

function SessionDiffContent(props: SessionDiffProps) {
  const preferences = loadSessionDiffPreferences();
  const [collapsedPaths, setCollapsedPaths] = createSignal(new Set<string>());
  const [menu, setMenu] = createSignal<SessionDiffMenuData | null>(null);
  const [scope, setScope] = createSignal<SessionDiffScope>({ scope: "all" });
  const [split, setSplit] = createSignal(preferences.split);
  const [wrap, setWrap] = createSignal(preferences.wrap);
  const [value, setValue] = createSignal<DiffValue | null>(null);
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<{ error: unknown } | null>(null);
  const [gapRevision, setGapRevision] = createSignal(0);
  const fileTextCache = new WeakMap<FileView, Promise<string[] | null>>();
  const unavailableFileText = new WeakSet<FileView>();
  let generation = 0;
  let disposed = false;
  const nativeGateways = nativeGatewaysCapability();
  const unsubscribe = nativeGateways?.subscribe(() => setMenu(null));
  onCleanup(() => {
    disposed = true;
    generation += 1;
    unsubscribe?.();
  });

  async function loadDiff(
    prefetched?: SessionsDiffResult,
    target = { loader: props.loader, owner: props.owner, scope: untrack(scope) },
  ) {
    const { loader, owner, scope: requestedScope } = target;
    const request = ++generation;
    setFailure(null);
    if (!loader) {
      setValue(null);
      setPending(false);
      return;
    }
    setPending(true);
    try {
      const result = prefetched ?? (await loader(requestedScope));
      if (
        disposed ||
        request !== generation ||
        props.loader !== loader ||
        props.owner !== owner ||
        untrack(scope) !== requestedScope
      ) {
        return;
      }
      const views = result.files.map((file) => ({
        file,
        parsed: file.patch
          ? parseSessionDiffPatch(file.patch, (count) =>
              t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
            )
          : null,
      }));
      setValue({ owner, scope: requestedScope, result, views });
      const currentPaths = new Set(views.map((view) => view.file.path));
      setCollapsedPaths((paths) => new Set([...paths].filter((path) => currentPaths.has(path))));
    } catch (error) {
      if (
        !disposed &&
        request === generation &&
        props.loader === loader &&
        props.owner === owner &&
        untrack(scope) === requestedScope
      ) {
        setFailure({ error });
      }
    } finally {
      if (!disposed && request === generation) {
        setPending(false);
      }
    }
  }
  const requestTarget = createMemo(
    () => ({ loader: props.loader, owner: props.owner, scope: scope() }),
    {
      equals: (previous, next) =>
        previous.loader === next.loader &&
        previous.owner === next.owner &&
        previous.scope === next.scope,
    },
  );
  createEffect(requestTarget, (target) => {
    // A nested bridge mount can flush this effect under its outer component owner.
    runWithOwner(null, () => {
      void loadDiff(undefined, target);
    });
  });
  const loading = () => props.loader !== null && pending();
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
      case "collapse-all":
        setCollapsedPaths(new Set(untrack(value)?.views.map((view) => view.file.path) ?? []));
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
            onClick={() => void loadDiff()}
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
      view.parsed !== null &&
      !view.parsed.truncated &&
      !unavailableFileText.has(view)
    );
  }
  function loadFileLines(view: FileView) {
    const cached = fileTextCache.get(view);
    if (cached) {
      return cached;
    }
    const load = props.loadFileText;
    const result = load
      ? load(view.file.path)
          .then((text) => (text === null ? null : splitSessionDiffFileText(text)))
          .catch(() => null)
      : Promise.resolve(null);
    fileTextCache.set(view, result);
    return result;
  }
  async function expandGap(view: FileView, line: DiffLine, direction: SessionDiffGapDirection) {
    const parsed = view.parsed;
    const loader = props.loader;
    if (!parsed || !line.gap || !loader || !canExpandGaps(view)) {
      return;
    }
    const requestedScope = scope();
    const owner = props.owner;
    const fileTextLoader = props.loadFileText;
    const request = generation;
    const isCurrent = () =>
      !disposed &&
      generation === request &&
      props.loader === loader &&
      props.owner === owner &&
      props.loadFileText === fileTextLoader &&
      scope() === requestedScope &&
      Boolean(untrack(value)?.views.includes(view));
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
      fileTextCache.delete(view);
      await loadDiff(freshResult);
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
      unavailableFileText.add(view);
    }
    setGapRevision((revision) => revision + 1);
  }
  function Gap(gapProps: { view: FileView; line: DiffLine }): JSX.Element {
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
                class={direction === "all" ? "session-diff__gap-count" : undefined}
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
  function FileBody(body: { view: FileView; result: SessionsDiffResult }) {
    const lines = () => {
      gapRevision();
      return body.view.parsed?.lines ?? [];
    };
    return (
      <Show
        when={body.view.file.binary !== true && body.view.parsed}
        fallback={
          <div class="session-diff__note">
            {t(
              body.view.file.binary === true
                ? "chat.sessionDiff.binaryFile"
                : body.result.unavailableReason === "workspace_stopped"
                  ? "chat.sessionDiff.workspaceStoppedFile"
                  : "chat.sessionDiff.previewUnavailable",
            )}
          </div>
        }
      >
        <Show
          when={split()}
          fallback={
            <DiffBlock
              lines={lines()}
              renderSkip={(line) => <Gap view={body.view} line={line} />}
              file={body.view.file}
            />
          }
        >
          <SessionSplitDiff
            lines={lines()}
            renderSkip={(line) => <Gap view={body.view} line={line} />}
            file={body.view.file}
          />
        </Show>
        {body.view.parsed?.truncated && (
          <div class="session-diff__note">{t("chat.sessionDiff.truncatedFile")}</div>
        )}
      </Show>
    );
  }
  function File(fileProps: { view: FileView; result: SessionsDiffResult }) {
    const file = () => fileProps.view.file;
    const collapsed = () => collapsedPaths().has(file().path);
    const path = () => splitPath(file().path);
    const intrinsicSize = () => {
      gapRevision();
      return `auto ${Math.max(80, Math.min(12_000, (fileProps.view.parsed?.lines.length ?? 2) * 19))}px`;
    };
    const statusLabel = () => FILE_STATUS_LABELS[file().status] ?? FILE_STATUS_LABELS.modified;
    return (
      <section class="session-diff__file" data-status={file().status}>
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
              class={`session-diff__status session-diff__status--${file().status}`}
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
            <FileBody view={fileProps.view} result={fileProps.result} />
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
                  fallback={
                    result().unavailableReason !== "workspace_stopped" &&
                    result().truncated !== true ? (
                      <div class="session-diff__note">{t("chat.sessionDiff.empty")}</div>
                    ) : null
                  }
                >
                  {(view) => <File view={view} result={result()} />}
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
    <div
      class={["session-diff", { "session-diff--wrap": wrap() }]}
      aria-busy={loading() ? "true" : "false"}
    >
      <Show
        when={failure()}
        fallback={
          <Show
            when={
              loading() &&
              (!value() || value()!.owner !== props.owner || value()!.scope !== scope())
            }
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
  );
}

export const SessionDiffPanel = defineSolidBridge<SessionDiffProps>(
  "openclaw-session-diff",
  SessionDiffContent,
  {
    properties: {
      owner: { default: null, attribute: false },
      execNode: { default: null, attribute: false },
      loader: { default: null, attribute: false },
      loadFileText: { default: null, attribute: false },
      openFile: { default: null, attribute: false },
      revealFile: { default: null, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-diff": SolidBridgeElement<SessionDiffProps>;
  }
}
