import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import type { SessionDiffViewBindings } from "./session-diff-presentation.ts";
import { SessionDiffTree } from "./session-diff-tree.tsx";
import type { DiffValue, FileView } from "./session-diff-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function createSessionDiffResultViews(
  bindings: SessionDiffViewBindings,
  renderers: {
    File: (props: { view: FileView; result: SessionsDiffResult }) => JSX.Element;
    MobileSummary: (props: { result: SessionsDiffResult }) => JSX.Element;
    DesktopSummary: (props: { result: SessionsDiffResult }) => JSX.Element;
    Summary: (props: { result: SessionsDiffResult }) => JSX.Element;
  },
) {
  const {
    props,
    desktop,
    collapsedFiles,
    scope,
    split,
    mobileWrap,
    selectedPath,
    treeOpen,
    treeSearchOpen,
    treeQuery,
    motionInstant,
    gapRevision,
    jumpToFile,
    openAnchoredMenu,
    scopeTitle,
    setTreeSearch,
    setTreeQuery,
    setWide,
    closeTreeSearch,
  } = bindings;
  const { File, MobileSummary, DesktopSummary, Summary } = renderers;
  function MobileResultBody(body: { value: DiffValue }) {
    let viewport!: HTMLDivElement;
    onSettled(() => props.onScrollPortRef?.(viewport));
    const [edges, setEdges] = createSignal({ atStart: true, atEnd: true });
    const viewportRef = createScrollStateRef((_, state) => setEdges(state), {
      presented: () => props.active !== false,
      content: () => [
        body.value,
        Object.keys(collapsedFiles),
        mobileWrap(),
        split(),
        gapRevision(),
      ],
    });
    const result = () => body.value.result;
    return (
      <div
        class="session-diff-mobile__body"
        data-at-start={edges().atStart ? "true" : "false"}
        data-at-end={edges().atEnd ? "true" : "false"}
      >
        <div
          class="session-diff-mobile__scroll"
          ref={(element) => {
            viewport = element;
            viewportRef(element);
          }}
        >
          <Show
            when={
              result().unavailableReason !== "not_git" &&
              result().unavailableReason !== "unknown_session"
            }
          >
            <MobileSummary result={result()} />
          </Show>
          <Show
            when={
              result().unavailableReason === "not_git" ||
              result().unavailableReason === "unknown_session"
            }
          >
            <div class="session-diff__note">
              {t(
                result().unavailableReason === "not_git"
                  ? "chat.sessionDiff.notGit"
                  : "chat.sessionDiff.unknownSession",
              )}
            </div>
          </Show>
          <Show when={result().unavailableReason === "workspace_stopped"}>
            <div class="session-diff__note">{t("chat.sessionDiff.workspaceStopped")}</div>
          </Show>
          <Show
            when={result().unavailableReason === "unknown_commit"}
            fallback={
              <div class="session-diff__files">
                <For
                  each={body.value.views}
                  keyed={(view) => view.source}
                  fallback={
                    !result().unavailableReason && !result().truncated ? (
                      <PanelEmptyState
                        presentation="mobile"
                        icon={<Icon name="fileDiff" />}
                        heading={t("chat.sessionDiff.emptyTitle")}
                        description={t("chat.sessionDiff.mobileEmpty")}
                      />
                    ) : null
                  }
                >
                  {(view) => <File view={view()} result={result()} />}
                </For>
              </div>
            }
          >
            <div class="session-diff__note">{t("chat.sessionDiff.unknownCommit")}</div>
          </Show>
          <Show when={result().truncated}>
            <div class="session-diff__note">{t("chat.sessionDiff.truncatedResult")}</div>
          </Show>
          <Show when={result().commits?.length}>
            <button
              class="session-diff-mobile__commits"
              type="button"
              onClick={(event) =>
                openAnchoredMenu(
                  event,
                  { kind: "scope", active: scope(), result: result(), mobile: true },
                  "top-start",
                )
              }
            >
              <Icon name="history" />
              {t("chat.sessionDiff.mobileCommitCount", { count: String(result().commits?.length) })}
              <Icon name="chevronUp" />
            </button>
          </Show>
        </div>
      </div>
    );
  }
  function ResultBody(body: { value: DiffValue }) {
    const [readingViewport, setReadingViewport] = createSignal<HTMLDivElement>();
    createResizeObserver(
      () => {
        const element = readingViewport();
        return element &&
          desktop() &&
          props.active !== false &&
          body.value.result.unavailableReason !== "not_git" &&
          body.value.result.unavailableReason !== "unknown_session"
          ? [element]
          : [];
      },
      ([entry]) => setWide((entry?.contentRect.width ?? 0) >= 860),
    );
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
            <Show when={desktop()} fallback={<Summary result={result()} />}>
              <DesktopSummary result={result()} />
            </Show>
            {result().unavailableReason === "workspace_stopped" && (
              <div class="session-diff__note">{t("chat.sessionDiff.workspaceStopped")}</div>
            )}
            <button
              class="session-diff__section-title"
              hidden={desktop()}
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
            <div
              class="session-diff__reading-layout"
              style={
                desktop()
                  ? {
                      "--session-diff-add-width": `${Math.max(2, ...result().files.map((file) => String(file.additions).length + 1))}ch`,
                      "--session-diff-del-width": `${Math.max(2, ...result().files.map((file) => String(file.deletions).length + 1))}ch`,
                    }
                  : { display: "contents" }
              }
            >
              <Show when={desktop()}>
                <aside
                  class="session-diff__tree-sidebar"
                  data-open={treeOpen() ? "true" : "false"}
                  data-instant={motionInstant() ? "true" : "false"}
                  inert={!treeOpen()}
                  aria-hidden={treeOpen() ? "false" : "true"}
                >
                  <Show when={treeSearchOpen()}>
                    <input
                      ref={setTreeSearch}
                      type="search"
                      value={treeQuery()}
                      aria-label={t("chat.sessionDiff.searchFiles")}
                      placeholder={t("chat.sessionDiff.searchFiles")}
                      onInput={(event) => setTreeQuery(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          closeTreeSearch();
                        }
                      }}
                    />
                  </Show>
                  <SessionDiffTree
                    files={result().files}
                    query={treeQuery()}
                    selected={selectedPath()}
                    statsAvailable={!result().unavailableReason}
                    onSelect={jumpToFile}
                    active={props.active !== false && treeOpen()}
                    instant={motionInstant()}
                  />
                </aside>
              </Show>
              <div class="session-diff__files" ref={setReadingViewport}>
                {result().unavailableReason === "unknown_commit" ? (
                  <div class="session-diff__note">{t("chat.sessionDiff.unknownCommit")}</div>
                ) : (
                  <For
                    each={body.value.views}
                    keyed={(view) => view.source}
                    fallback={
                      result().unavailableReason !== "workspace_stopped" &&
                      result().truncated !== true ? (
                        desktop() ? (
                          <PanelEmptyState
                            icon={<Icon name="fileDiff" />}
                            heading={t("chat.sessionDiff.emptyTitle")}
                            description={t("chat.sessionDiff.empty")}
                          />
                        ) : (
                          <div class="session-diff__note">{t("chat.sessionDiff.empty")}</div>
                        )
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
            </div>
            <button
              class="session-diff__footer"
              hidden={desktop()}
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
  return { MobileResultBody, ResultBody };
}
