import { Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import { SessionDiffActionIcon } from "./session-diff-menus.tsx";
import type { SessionDiffViewBindings } from "./session-diff-presentation.ts";
import { totalDiffStat } from "./session-diff-presentation.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

export function createSessionDiffChrome(bindings: SessionDiffViewBindings) {
  const {
    props,
    collapsedFiles,
    scope,
    split,
    wrap,
    mobileWrap,
    mode,
    wordDiffs,
    selectedPath,
    treeOpen,
    treeSearchOpen,
    value,
    syncData,
    loading,
    toggleTree,
    searchTree,
    openAnchoredMenu,
    handleMenuAction,
    scopeTitle,
    loadDiff,
    setTreeSearchTrigger,
    refreshCollapsed,
    renderMobileSync,
  } = bindings;
  function MobileRail() {
    return (
      <div class="session-diff-mobile__rail">
        <button
          class="session-diff__scope"
          type="button"
          aria-label={t("chat.sessionDiff.scopeMenu")}
          onClick={(event) =>
            openAnchoredMenu(
              event,
              {
                kind: "scope",
                active: scope(),
                result: value()?.result ?? null,
                mobile: true,
              },
              "bottom-start",
            )
          }
        >
          <span
            ref={createTextOverflow(() => scopeTitle(value()?.result))}
            title={scopeTitle(value()?.result)}
          >
            {scopeTitle(value()?.result)}
          </span>
          <Icon name="chevronDown" />
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--icon session-diff__refresh"
          aria-label={t("chat.sessionDiff.refresh")}
          disabled={loading() || !props.loader}
          onClick={() => loadDiff()}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--icon session-diff__toolbar-icon"
          aria-label={t("chat.sessionDiff.viewOptions")}
          onClick={(event) =>
            openAnchoredMenu(event, {
              kind: "view",
              mobile: true,
              split: split(),
              wrap: mobileWrap(),
              sync: syncData() ?? undefined,
              canOpenSync: Boolean(props.onOpenMobilePage),
            })
          }
        >
          <Icon name="moreHorizontal" />
        </button>
      </div>
    );
  }
  function MobileSummary(summary: { result: SessionsDiffResult }) {
    return (
      <div class="session-diff-mobile__summary">
        <Show when={summary.result.branch || summary.result.baseRef}>
          <div class="session-diff-mobile__branch" title={summary.result.root}>
            <Icon name="gitBranch" />
            <span>
              <Show
                when={summary.result.baseRef && summary.result.baseRef !== summary.result.branch}
              >
                <small
                  ref={createTextOverflow(() => summary.result.baseRef)}
                  title={summary.result.baseRef}
                >
                  {summary.result.baseRef}
                </small>
              </Show>
              <Show when={summary.result.branch}>
                <span
                  ref={createTextOverflow(() => summary.result.branch)}
                  title={summary.result.branch}
                >
                  {summary.result.branch}
                </span>
              </Show>
            </span>
          </div>
        </Show>
        <div class="session-diff-mobile__counts">
          <Show when={!summary.result.unavailableReason}>
            <DiffStatChips
              stat={{ added: summary.result.additions, removed: summary.result.deletions }}
            />
          </Show>
          <Show when={summary.result.aheadCount != null}>
            <small>
              {t("chat.sessionDiff.mobileAhead", { count: String(summary.result.aheadCount) })}
            </small>
          </Show>
        </div>
      </div>
    );
  }
  function DesktopSummary(summary: { result: SessionsDiffResult }) {
    let secondary: HTMLDivElement | undefined;
    const allExpanded = () =>
      summary.result.files.length > 0 && Object.keys(collapsedFiles).length === 0;
    const modeLabel = () => t("chat.sessionDiff.cycleMode", { mode: mode() });
    return (
      <div class="session-diff__summary session-panel-rail" data-presentation="desktop">
        <div class="session-diff__tools">
          <div class="session-diff__navigation session-panel-rail__group">
            <openclaw-tooltip prop:content={t("chat.sessionDiff.fileTree")}>
              <button
                type="button"
                class="session-panel-rail__button"
                aria-label={t("chat.sessionDiff.fileTree")}
                aria-pressed={treeOpen() ? "true" : "false"}
                onClick={toggleTree}
              >
                <Icon name="panelLeft" />
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip prop:content={t("chat.sessionDiff.searchFiles")}>
              <button
                type="button"
                class="session-panel-rail__button"
                ref={setTreeSearchTrigger}
                aria-label={t("chat.sessionDiff.searchFiles")}
                aria-pressed={treeSearchOpen() ? "true" : "false"}
                onClick={searchTree}
              >
                <Icon name="search" />
              </button>
            </openclaw-tooltip>
            <span class="session-panel-rail__separator" aria-hidden="true" />
            <openclaw-tooltip prop:content={t("chat.sessionDiff.refresh")}>
              <button
                type="button"
                class="session-panel-rail__button session-diff__refresh"
                aria-label={t("chat.sessionDiff.refresh")}
                disabled={loading()}
                onClick={() => {
                  refreshCollapsed();
                }}
              >
                <Icon name="refresh" />
              </button>
            </openclaw-tooltip>
          </div>
          <div class="session-diff__actions session-panel-rail__group">
            <openclaw-tooltip prop:content={t("chat.sessionDiff.jumpToFile")}>
              <button
                class="session-panel-rail__button session-diff__jump"
                type="button"
                aria-label={t("chat.sessionDiff.jumpToFile")}
                disabled={summary.result.files.length === 0}
                onClick={(event) =>
                  openAnchoredMenu(event, {
                    kind: "jump",
                    paths: summary.result.files.map((file) => file.path),
                    selected: selectedPath(),
                  })
                }
              >
                <SessionDiffActionIcon action="jump" />
              </button>
            </openclaw-tooltip>
            <div
              class="session-diff__secondary"
              ref={(element) => {
                secondary = element;
              }}
            >
              <openclaw-tooltip prop:content={t("chat.sessionDiff.wrapLines")}>
                <button
                  type="button"
                  class="session-panel-rail__button"
                  aria-label={t("chat.sessionDiff.wrapLines")}
                  aria-pressed={wrap() ? "true" : "false"}
                  onClick={() => handleMenuAction({ kind: "toggle-wrap" })}
                >
                  <Icon name="wrapText" />
                </button>
              </openclaw-tooltip>
              <openclaw-tooltip
                prop:content={t(
                  allExpanded() ? "chat.sessionDiff.collapseAll" : "chat.sessionDiff.expandAll",
                )}
              >
                <button
                  type="button"
                  class="session-panel-rail__button"
                  aria-label={t(
                    allExpanded() ? "chat.sessionDiff.collapseAll" : "chat.sessionDiff.expandAll",
                  )}
                  aria-pressed={allExpanded() ? "true" : "false"}
                  disabled={summary.result.files.length === 0}
                  onClick={() =>
                    handleMenuAction({ kind: allExpanded() ? "collapse-all" : "expand-all" })
                  }
                >
                  <SessionDiffActionIcon action={allExpanded() ? "collapse" : "expand"} />
                </button>
              </openclaw-tooltip>
              <openclaw-tooltip prop:content={modeLabel()}>
                <button
                  type="button"
                  class="session-panel-rail__button"
                  aria-label={modeLabel()}
                  aria-pressed={mode() === "split" ? "true" : "false"}
                  onClick={() =>
                    handleMenuAction({
                      kind: "mode",
                      value:
                        mode() === "auto" ? "unified" : mode() === "unified" ? "split" : "auto",
                    })
                  }
                >
                  <Icon name="columns2" />
                </button>
              </openclaw-tooltip>
            </div>
            <openclaw-tooltip prop:content={t("chat.sessionDiff.viewOptions")}>
              <button
                type="button"
                class="session-panel-rail__button session-diff__toolbar-icon"
                aria-label={t("chat.sessionDiff.viewOptions")}
                onClick={(event) =>
                  openAnchoredMenu(event, {
                    kind: "view",
                    desktop: true,
                    compact: secondary ? getComputedStyle(secondary).display === "none" : false,
                    allExpanded: allExpanded(),
                    hasFiles: summary.result.files.length > 0,
                    split: split(),
                    wrap: wrap(),
                    mode: mode(),
                    wordDiffs: wordDiffs(),
                    sync: syncData() ?? undefined,
                  })
                }
              >
                <Icon name="moreHorizontal" />
              </button>
            </openclaw-tooltip>
          </div>
        </div>
        <div class="session-diff__scope-group session-panel-rail__group">
          <button
            class="session-diff__scope session-panel-rail__button session-panel-rail__button--labelled"
            type="button"
            aria-label={t("chat.sessionDiff.scopeMenu")}
            aria-description={scopeTitle(summary.result)}
            onClick={(event) =>
              openAnchoredMenu(
                event,
                {
                  kind: "scope",
                  active: scope(),
                  result: summary.result,
                  desktop: true,
                },
                "bottom-end",
              )
            }
          >
            <span ref={createTextOverflow(() => scopeTitle(summary.result))}>
              {scopeTitle(summary.result)}
            </span>
            <Icon name="chevronDown" class="session-panel-rail__chevron" />
          </button>
          <Show when={!summary.result.unavailableReason}>
            <DiffStatChips
              stat={{ added: summary.result.additions, removed: summary.result.deletions }}
            />
          </Show>
        </div>
      </div>
    );
  }
  function Summary(summary: { result: SessionsDiffResult }) {
    const branchLabel = () =>
      summary.result.baseRef &&
      summary.result.branch &&
      summary.result.baseRef !== summary.result.branch
        ? `${summary.result.baseRef} → ${summary.result.branch}`
        : (summary.result.branch ?? summary.result.baseRef ?? "");
    const syncCommand = () => syncData()?.command;
    return (
      <div class="session-diff__summary">
        <span
          class="session-diff__branch"
          title={[branchLabel(), summary.result.root].filter(Boolean).join("\n")}
        >
          <Icon name="gitBranch" />
          <span ref={createTextOverflow(branchLabel)} class="session-diff__branch-label">
            {branchLabel()}
          </span>
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
              onClick={(event) => {
                if (props.mobile === true && props.onOpenMobilePage) {
                  props.onOpenMobilePage(
                    {
                      key: "session-diff-sync",
                      title: t("chat.sessionDiff.syncLocally"),
                      render: renderMobileSync,
                    },
                    event.currentTarget,
                  );
                  return;
                }
                openAnchoredMenu(event, {
                  kind: "sync",
                  command: command(),
                  root: summary.result.root!,
                  branch: summary.result.branch!,
                });
              }}
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
              openAnchoredMenu(event, {
                kind: "view",
                split: split(),
                wrap: wrap(),
                ...(syncCommand()
                  ? {
                      sync: {
                        command: syncCommand()!,
                        root: summary.result.root!,
                        branch: summary.result.branch!,
                      },
                    }
                  : {}),
              })
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
            onClick={() => {
              loadDiff();
            }}
          >
            <Icon name="refresh" />
          </button>
        </openclaw-tooltip>
      </div>
    );
  }
  return { MobileRail, MobileSummary, DesktopSummary, Summary };
}
