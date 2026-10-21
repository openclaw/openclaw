import type { JSX } from "@solidjs/web";
import { createMemo, For, onSettled, Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { pairSessionDiffLines } from "../../../lib/chat/session-diff-split.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { createDiffPresentation } from "./chat-diff-render.solid.tsx";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import { FileDisclosure } from "./file-disclosure.tsx";
import { SessionDiffOpenIcon } from "./session-diff-icons.tsx";
import type { SessionDiffViewBindings } from "./session-diff-presentation.ts";
import { FILE_STATUS_LABELS, diffStat, splitPath } from "./session-diff-presentation.ts";
import { SessionDiffFileBody } from "./session-diff-render.tsx";
import { ReviewFilename } from "./session-diff-tree.tsx";
import type { FileView } from "./session-diff-types.ts";

export function createSessionDiffFileView(bindings: SessionDiffViewBindings) {
  const {
    props,
    desktop,
    mobile,
    collapsedPaths,
    wordDiffs,
    selectedPath,
    motionInstant,
    gapRevision,
    pairedRows,
    effectiveSplit,
    toggleFile,
    openAnchoredMenu,
    expandGap,
    canExpandGaps,
    collapseGap,
    registerPresentation,
    registerFileElement,
  } = bindings;
  function Gap(gapProps: { view: FileView; line: DiffLine }): JSX.Element {
    const gap = () => gapProps.line.gap;
    const chunkCount = () => (gap()!.count <= 25 ? gap()!.count : 20);
    const expanded = () => {
      gapRevision();
      return gapProps.view.source.expandedGaps?.get(gapProps.line);
    };
    const label = () => {
      const count = gap()?.count;
      if (count === undefined) {
        return gapProps.line.text;
      }
      return t(
        expanded()
          ? count === 1
            ? "chat.sessionDiff.collapseContextLine"
            : "chat.sessionDiff.collapseContext"
          : count === 1
            ? "chat.sessionDiff.unmodifiedLine"
            : "chat.sessionDiff.unmodifiedLines",
        { count: String(count) },
      );
    };
    const ContextText = () => (
      <>
        <span aria-hidden="true">···</span>
        <span class="session-diff__context-full">{label()}</span>
        <Show when={gap()}>
          {(context) => (
            <span class="session-diff__context-short" aria-hidden="true">
              {t(
                context().count === 1
                  ? "chat.sessionDiff.contextLine"
                  : "chat.sessionDiff.contextLines",
                { count: String(context().count) },
              )}
            </span>
          )}
        </Show>
      </>
    );
    return (
      <Show
        when={gap() && canExpandGaps(gapProps.view)}
        fallback={
          desktop() ? (
            <span class="session-diff__context-label" title={label()} aria-label={label()}>
              <ContextText />
            </span>
          ) : (
            gapProps.line.text
          )
        }
      >
        {desktop() ? (
          <button
            class="session-diff__context-toggle"
            type="button"
            aria-label={label()}
            title={label()}
            aria-expanded={expanded() ? "true" : "false"}
            onClick={() => {
              if (expanded()) {
                collapseGap(gapProps.view, gapProps.line);
              } else {
                void expandGap(gapProps.view, gapProps.line, "all");
              }
            }}
          >
            <ContextText />
          </button>
        ) : (
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
              {([direction, labelKey]) => (
                <button
                  class={{ "session-diff__gap-count": direction === "all" }}
                  type="button"
                  aria-label={t(`chat.sessionDiff.${labelKey}`, {
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
        )}
      </Show>
    );
  }
  function File(fileProps: { view: FileView; result: SessionsDiffResult }) {
    let fileElement!: HTMLElement;
    let fileToggle: HTMLButtonElement | undefined;
    // The keyed list retains this owner by source, not refreshed metadata.
    const source = () => fileProps.view.source;
    const file = () => fileProps.view.file;
    const collapsed = () => collapsedPaths().has(file().path);
    // The pairing budget skips collapsed files. Keep its last real result while
    // the desktop reader is still painting its exit, rather than emptying Split.
    const rows = createMemo<ReturnType<typeof pairSessionDiffLines>>(
      (previous) =>
        pairedRows().get(fileProps.view) ?? (desktop() && collapsed() ? previous : undefined) ?? [],
    );
    const presentation = createDiffPresentation({
      get wordDiffs() {
        return desktop() ? wordDiffs() : true;
      },
      get active() {
        return props.active !== false && !collapsed();
      },
      get lines() {
        gapRevision();
        return source().parsed?.lines ?? [];
      },
      get file() {
        return fileProps.view.file;
      },
      get rows() {
        return rows();
      },
    });
    // A retained source has one immutable file path across metadata refreshes.
    onSettled(() => {
      const path = file().path;
      registerFileElement(path, fileElement, () => fileToggle);
      return registerPresentation(path, presentation);
    });
    const path = () => splitPath(file().path);
    const intrinsicSize = () => {
      gapRevision();
      return `auto ${Math.max(80, Math.min(12_000, (source().parsed?.lines.length ?? 2) * 19))}px`;
    };
    const statusLabel = () => FILE_STATUS_LABELS[file().status] ?? FILE_STATUS_LABELS.modified;
    const body = () => (
      <div class="session-diff__file-body" style={{ "contain-intrinsic-size": intrinsicSize() }}>
        <SessionDiffFileBody
          file={file()}
          parsed={source().parsed}
          unavailableReason={fileProps.result.unavailableReason}
          split={effectiveSplit()}
          presentation={presentation}
          renderSkip={(line) => <Gap view={fileProps.view} line={line} />}
        />
      </div>
    );
    return (
      <section
        class={[
          "session-diff__file",
          { "is-selected": desktop() && selectedPath() === file().path },
        ]}
        data-status={file().status}
        data-collapsed={collapsed() ? "true" : "false"}
        ref={(element) => {
          fileElement = element;
        }}
      >
        <presentation.SyntaxLifetime />
        <div
          class="session-diff__file-header"
          onClick={(event) => {
            if (desktop() && event.target instanceof Element && !event.target.closest("button")) {
              toggleFile(file().path);
              fileToggle?.focus({ preventScroll: true });
            }
          }}
        >
          <button
            ref={(element) => {
              fileToggle = element;
            }}
            class="session-diff__file-toggle"
            type="button"
            aria-expanded={collapsed() ? "false" : "true"}
            aria-label={
              desktop() || mobile() ? `${file().path} — ${t(statusLabel()[1])}` : undefined
            }
            title={
              desktop() || mobile()
                ? undefined
                : file().oldPath
                  ? `${file().oldPath} → ${file().path}`
                  : file().path
            }
            onClick={() => toggleFile(file().path)}
          >
            <span
              class={["session-diff__chevron", { "session-diff__chevron--open": !collapsed() }]}
              hidden={desktop()}
            >
              <Icon name="chevronRight" />
            </span>
            {desktop() && <AttachmentFileIcon filename={file().path} mode="preview-with-favicon" />}
            <span
              class={["session-diff__status", `session-diff__status--${file().status}`]}
              title={t(statusLabel()[1])}
              hidden={desktop()}
            >
              {statusLabel()[0]}
            </span>
            <span class="session-diff__path">
              {file().oldPath && <span class="session-diff__old-path">{file().oldPath} →</span>}
              {desktop() && path().directory && (
                <span class="session-diff__directory">{path().directory}/</span>
              )}
              <span class="session-diff__filename">
                {desktop() ? <ReviewFilename name={path().name} /> : path().name}
              </span>
              {desktop() && (
                <span
                  class={["session-diff__chevron", { "session-diff__chevron--open": !collapsed() }]}
                >
                  <Icon name="chevronRight" />
                </span>
              )}
              {!desktop() && path().directory && (
                <span class="session-diff__directory">{path().directory}</span>
              )}
              {mobile() && file().untracked === true && (
                <small class="session-diff__directory">{t("chat.sessionDiff.untracked")}</small>
              )}
            </span>
            {!mobile() && file().untracked === true && (
              <span class="session-diff__badge">{t("chat.sessionDiff.untracked")}</span>
            )}
            {fileProps.result.unavailableReason !== "workspace_stopped" && (
              <DiffStatChips
                stat={
                  desktop()
                    ? { added: file().additions, removed: file().deletions }
                    : mobile()
                      ? { added: file().additions, removed: file().deletions }
                      : diffStat(file())
                }
              />
            )}
          </button>
          {desktop() && props.openFile && (
            <button
              type="button"
              class="btn btn--ghost btn--icon session-diff__open-file"
              aria-label={t("chat.sessionDiff.openFile")}
              title={t("chat.sessionDiff.openFile")}
              onClick={() => {
                void props.openFile?.(file().path);
              }}
            >
              <SessionDiffOpenIcon />
            </button>
          )}
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
                desktop: desktop(),
                collapsed: collapsed(),
                mobile: mobile(),
                canReadMarkdown:
                  desktop() &&
                  Boolean(props.openFileView) &&
                  /\.(md|markdown)$/i.test(file().path) &&
                  file().status !== "deleted" &&
                  file().binary !== true,
                canViewSource:
                  desktop() &&
                  Boolean(props.openFileView) &&
                  file().status !== "deleted" &&
                  file().binary !== true,
                canEdit:
                  desktop() &&
                  Boolean(props.openFileView) &&
                  file().status !== "deleted" &&
                  file().binary !== true,
              });
            }}
          >
            <Icon name="moreHorizontal" />
          </button>
        </div>
        <Show when={desktop()} fallback={<Show when={!collapsed()}>{body()}</Show>}>
          <FileDisclosure
            variant="review"
            open={!collapsed()}
            active={props.active !== false}
            instant={motionInstant()}
          >
            {body()}
          </FileDisclosure>
        </Show>
      </section>
    );
  }
  return File;
}
