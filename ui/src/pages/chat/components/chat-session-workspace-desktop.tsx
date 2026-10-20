import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { createPendingFocus } from "../../../lib/reactive/pending-focus.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { isSessionWorkspaceFileSelected } from "../../../lib/sessions/workspace.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { WorkspaceTranscriptAttachments } from "./chat-session-workspace-attachments.tsx";
import { WorkspaceBreadcrumb } from "./chat-session-workspace-breadcrumb.tsx";
import {
  projectWorkspaceCatalog,
  splitWorkspaceFilename,
  workspaceCatalogChildren,
  workspaceCatalogFilters,
  workspaceCatalogSearch,
  workspaceSessionFiles,
  type WorkspaceCatalogFile,
  type WorkspaceCatalogRow,
} from "./chat-session-workspace-catalog.ts";
import { FolderDisclosure } from "./chat-session-workspace-disclosure.tsx";
import type {
  SessionWorkspaceFilter,
  SessionWorkspaceProps,
} from "./chat-sidebar-content-types.ts";
import { hasTranscriptAttachments } from "./chat-transcript-attachments.ts";
import "../../../styles/session-panel-rail.css";
import "./chat-session-workspace-desktop.css";

function WorkspaceFilename(props: { name: string }) {
  const parts = createMemo(() => splitWorkspaceFilename(props.name));
  const [overflow, setOverflow] = createSignal(false);
  let stem: HTMLSpanElement | undefined;
  const schedule = createLayoutMeasurement(
    () => props.name,
    () => {
      const overflowing = Boolean(stem && stem.scrollWidth > stem.clientWidth);
      return () => setOverflow(overflowing);
    },
    { targets: () => (stem ? [stem] : []) },
  );
  onSettled(() => {
    if (!stem) {
      return undefined;
    }
    let active = true;
    const update = () => {
      if (active) {
        schedule();
      }
    };
    void document.fonts.ready.then(update);
    return () => {
      active = false;
    };
  });
  return (
    <span class="workspace-desktop__filename">
      <span
        ref={(element) => {
          stem = element;
        }}
        class={["workspace-desktop__stem", { "is-overflowed": overflow() }]}
      >
        {parts().stem}
      </span>
      <span>{parts().extension}</span>
    </span>
  );
}

function RailRow(props: {
  file: WorkspaceCatalogFile;
  workspace: SessionWorkspaceProps;
  depth?: number;
  directory?: boolean;
  expanded?: boolean;
  searching?: boolean;
  onToggle?: (instant: boolean) => void;
}) {
  const selected = () =>
    props.file.artifactId ||
    (props.file.origin === "session" && props.file.workspacePath === undefined)
      ? props.workspace.activeId === props.file.key
      : isSessionWorkspaceFileSelected(
          props.workspace.activeId,
          props.workspace.sessionKey,
          props.workspace.list?.root,
          props.file.path,
          props.file.workspacePath,
        );
  const onOpen = (disposition: "preview" | "pinned" = "preview") => {
    if (props.file.artifactId) {
      props.workspace.onOpenArtifact(props.file.artifactId, disposition);
    } else {
      props.workspace.onOpenFile(props.file.path, props.file.origin, disposition);
    }
  };
  const activity = () =>
    props.file.activity === "modified" || props.file.activity === "mixed"
      ? t("chat.workspaceFiles.changed")
      : props.file.activity === "read"
        ? t("chat.workspaceFiles.read")
        : undefined;
  return (
    <div role="listitem" class="workspace-desktop__item">
      <button
        type="button"
        class={["workspace-desktop__row", { "is-active": selected() }]}
        style={{
          "padding-inline-start": `min(calc(8px + ${props.depth ?? 0} * var(--workspace-tree-step, 16px)), max(8px, calc(100% - 100px)))`,
        }}
        aria-label={props.file.path}
        aria-description={activity()}
        aria-current={selected() ? "true" : undefined}
        aria-expanded={props.directory ? (props.expanded ? "true" : "false") : undefined}
        onClick={(event) => {
          if (props.directory) {
            props.onToggle?.(event.detail === 0);
          } else {
            onOpen();
          }
        }}
        onDblClick={() => {
          if (!props.directory) {
            onOpen("pinned");
          }
        }}
      >
        <Show
          when={props.directory}
          fallback={
            <AttachmentFileIcon
              filename={props.file.name}
              mimeType={props.file.mimeType}
              mode="preview-with-favicon"
            />
          }
        >
          <span class="workspace-desktop__folder-icon">
            <Show when={props.expanded} fallback={<Icon name="folder" />}>
              {/* Lucide folder-open, the approved Files glyph (ISC). */}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
              </svg>
            </Show>
          </span>
        </Show>
        <span class="workspace-desktop__identity">
          <span class="workspace-desktop__name-line">
            <WorkspaceFilename name={props.file.name} />
            <Show when={!props.directory && activity()}>
              <span
                class={[
                  "workspace-desktop__activity",
                  { "is-changed": props.file.activity !== "read" },
                ]}
                role="img"
                aria-label={activity()}
              />
            </Show>
          </span>
          <Show when={props.searching}>
            <span class="workspace-desktop__location">
              {props.file.artifactId
                ? t("chat.workspaceFiles.desktop.sessionFiles")
                : (props.file.workspacePath ?? props.file.path)}
            </span>
          </Show>
        </span>
      </button>
    </div>
  );
}

function DirectoryBranch(props: {
  row: WorkspaceCatalogRow;
  workspace: SessionWorkspaceProps;
  childrenByPath: ReadonlyMap<string, readonly WorkspaceCatalogRow[]>;
  depth: number;
}) {
  const path = () => props.row.workspacePath ?? props.row.path;
  const expanded = () => props.workspace.navigation?.expandedPaths.includes(path()) ?? false;
  const active = () =>
    props.workspace.navigation?.treeVisible !== false && !props.workspace.navigation?.searchOpen;
  const [instant, setInstant] = createSignal(true);
  const directory = () => props.workspace.directories?.[path()];
  const browser = () =>
    directory()?.browser ??
    (!props.workspace.list?.browser?.search && props.workspace.list?.browser?.path === path()
      ? props.workspace.list.browser
      : undefined);
  return (
    <div class="workspace-desktop__branch">
      <RailRow
        file={props.row}
        workspace={props.workspace}
        directory={props.row.directory}
        depth={props.depth}
        expanded={expanded()}
        onToggle={(immediate) => {
          setInstant(immediate);
          props.workspace.onToggleDirectory?.(path());
        }}
      />
      <Show when={props.row.directory}>
        <FolderDisclosure open={expanded()} active={active()} instant={instant()}>
          <Show when={directory()?.loading}>
            <div class="workspace-desktop__notice" role="status">
              {t("chat.workspaceFiles.loading")}
            </div>
          </Show>
          <Show when={directory()?.error != null}>
            <div class="workspace-desktop__notice" role="alert">
              {directory()?.error || t("chat.workspaceFiles.folderUnavailable")}
            </div>
          </Show>
          <Show when={browser()?.truncated}>
            <div class="workspace-desktop__notice" role="status">
              {t("chat.workspaceFiles.truncated")}
            </div>
          </Show>
          <div role="list">
            <For each={props.childrenByPath.get(path()) ?? []} keyed={(row) => row.key}>
              {(row) => (
                <DirectoryBranch
                  row={row()}
                  workspace={props.workspace}
                  childrenByPath={props.childrenByPath}
                  depth={props.depth + 1}
                />
              )}
            </For>
          </div>
        </FolderDisclosure>
      </Show>
    </div>
  );
}

function WorkspaceGroup(props: {
  label?: string;
  expanded: boolean;
  onToggle: () => void;
  children: JSX.Element;
  class?: string;
  animate?: boolean;
  active?: boolean;
}) {
  const [instant, setInstant] = createSignal(true);
  return (
    <section class={props.class}>
      <Show when={props.label}>
        <button
          class="workspace-desktop__heading"
          type="button"
          aria-expanded={props.expanded ? "true" : "false"}
          onClick={(event) => {
            setInstant(event.detail === 0);
            props.onToggle();
          }}
        >
          <span>{props.label}</span>
          <Icon name={props.expanded ? "chevronDown" : "chevronRight"} />
        </button>
      </Show>
      <Show
        when={props.animate}
        fallback={
          <div class="workspace-desktop__group-content" hidden={!props.expanded}>
            {props.children}
          </div>
        }
      >
        <FolderDisclosure open={props.expanded} active={props.active !== false} instant={instant()}>
          {props.children}
        </FolderDisclosure>
      </Show>
    </section>
  );
}

function ActivityMenu(props: {
  workspace: SessionWorkspaceProps;
  filters: readonly SessionWorkspaceFilter[];
  filter: SessionWorkspaceFilter;
}) {
  const id = createUniqueId();
  const label = (filter: SessionWorkspaceFilter) =>
    filter === "all"
      ? t("chat.workspaceFiles.filterAll")
      : filter === "artifacts"
        ? t("chat.workspaceFiles.desktop.sessionFiles")
        : t(`chat.workspaceFiles.${filter}`);
  return (
    <Show when={props.filters.length > 1 && !props.workspace.navigation?.searchOpen}>
      <div class="session-panel-rail__group">
        <Menu
          id={`workspace-activity-${id}`}
          label={`${t("chat.workspaceFiles.filters")}: ${label(props.filter)}`}
          class="workspace-desktop__activity-menu"
          panelClass="workspace-desktop__menu"
          triggerClass="session-panel-rail__button session-panel-rail__button--labelled"
          trigger={
            <>
              <span>{label(props.filter)}</span>
              <Icon name="chevronDown" class="session-panel-rail__chevron" />
            </>
          }
          items={props.filters.map((filter) => ({
            id: filter,
            label: label(filter),
            type: "radio",
            checked: props.filter === filter,
            icon:
              filter === "all" ? (
                // Lucide files, the approved activity glyph (ISC).
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
                  <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
                  <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
                </svg>
              ) : (
                <Icon
                  name={
                    filter === "read" ? "eye" : filter === "artifacts" ? "paperclip" : "fileDiff"
                  }
                />
              ),
          }))}
          onSelect={(item) => {
            const filter = props.filters.find((candidate) => candidate === item.id);
            if (filter) {
              props.workspace.onSetFilter(filter);
            }
          }}
        />
      </div>
    </Show>
  );
}

export function DesktopWorkspaceContents(props: { workspace: SessionWorkspaceProps }) {
  let searchField: HTMLInputElement | undefined;
  const searchValue = liveValue(() => props.workspace.browserSearch);
  let searchButton: HTMLButtonElement | undefined;
  const [treeScroll, setTreeScroll] = createSignal<HTMLDivElement>();
  const [sessionScroll, setSessionScroll] = createSignal<HTMLDivElement>();
  const catalog = createMemo(() =>
    projectWorkspaceCatalog(props.workspace.list, props.workspace.directories),
  );
  const filters = createMemo(() =>
    props.workspace.folderView
      ? workspaceCatalogFilters(catalog(), props.workspace.browserPath)
      : catalog().filters,
  );
  const filter = () =>
    filters().includes(props.workspace.filter) ? props.workspace.filter : "all";
  const navigation = () => props.workspace.navigation;
  const root = () => props.workspace.browserPath;
  const expanded = () => navigation()?.expandedPaths ?? [""];
  const directoryBrowser = (path: string) =>
    props.workspace.directories?.[path]?.browser ??
    (!props.workspace.list?.browser?.search && props.workspace.list?.browser?.path === path
      ? props.workspace.list.browser
      : undefined);
  const childrenByPath = createMemo(() => workspaceCatalogChildren(catalog(), filter()));
  const sessionFiles = createMemo(() =>
    props.workspace.folderView ? [] : workspaceSessionFiles(catalog(), filter()),
  );
  const searchResults = createMemo(() =>
    workspaceCatalogSearch(props.workspace.list, props.workspace.browserSearch),
  );
  const searchTruncated = () => {
    const query = props.workspace.browserSearch.trim().toLowerCase();
    const browser = props.workspace.list?.browser;
    return Boolean(query && browser?.truncated && browser.search?.toLowerCase() === query);
  };
  const attachmentsVisible = () =>
    !props.workspace.folderView &&
    filter() === "all" &&
    hasTranscriptAttachments(props.workspace.transcriptAttachments);
  const attachmentSearchVisible = () =>
    hasTranscriptAttachments(props.workspace.transcriptAttachments, props.workspace.browserSearch);
  const projectVisible = () =>
    filter() !== "artifacts" &&
    Boolean(directoryBrowser(root()) || props.workspace.list?.browser || catalog().project.size);
  let restoreSearchFocus = false;
  // Focus after visibility commits, only when search changes state.
  createPendingFocus(() => Boolean(navigation()?.searchOpen), {
    requested: (open, previous) => open !== (previous ?? false),
    focus: (open) => {
      if (open) {
        searchField?.focus({ preventScroll: true });
      } else if (restoreSearchFocus) {
        restoreSearchFocus = false;
        searchButton?.focus({ preventScroll: true });
      }
    },
  });
  // A new owner snapshot reapplies offsets after catalog reveal, even when the numbers match.
  const savedScroll = createMemo(() => ({
    tree: navigation()?.treeScroll,
    session: navigation()?.sessionScroll,
  }));
  createScrollPosition(() => ({
    restore: {
      identity: [savedScroll(), treeScroll()],
      target: treeScroll(),
      top: savedScroll().tree ?? 0,
    },
  }));
  createScrollPosition(() => ({
    restore: {
      identity: [savedScroll(), sessionScroll()],
      target: sessionScroll(),
      top: savedScroll().session ?? 0,
    },
  }));
  const closeSearch = () => {
    restoreSearchFocus = true;
    props.workspace.onSearchOpenChange?.(false);
  };
  return (
    <aside
      class={["workspace-desktop", { "workspace-desktop--session-only": !projectVisible() }]}
      aria-label={t("chat.workspaceFiles.label")}
      hidden={navigation()?.treeVisible === false}
    >
      <Show when={props.workspace.folderView && !navigation()?.searchOpen}>
        <div class="workspace-desktop__folder-bar session-panel-rail" data-presentation="desktop">
          <Icon name="folder" />
          <WorkspaceBreadcrumb
            path={root()}
            rootLabel={
              props.workspace.list?.root?.split("/").findLast(Boolean) ||
              t("chat.workspaceFiles.root")
            }
            onBrowsePath={(path) => props.workspace.onBrowsePath(path)}
          />
        </div>
      </Show>
      <div class="workspace-desktop__toolbar session-panel-rail" data-presentation="desktop">
        <div class="session-panel-rail__group" hidden={navigation()?.searchOpen}>
          <button
            ref={(element) => {
              searchButton = element;
            }}
            type="button"
            class="workspace-desktop__search-toggle session-panel-rail__button"
            hidden={navigation()?.searchOpen}
            aria-label={t("chat.workspaceFiles.search")}
            onClick={() => props.workspace.onSearchOpenChange?.(true)}
          >
            <Icon name="search" />
          </button>
        </div>
        <label class="workspace-desktop__search" hidden={!navigation()?.searchOpen}>
          <input
            type="search"
            aria-label={t("chat.workspaceFiles.search")}
            placeholder={t("chat.workspaceFiles.search")}
            ref={(element) => {
              searchField = element;
              searchValue(element);
            }}
            onInput={(event) => props.workspace.onSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              if (props.workspace.browserSearch) {
                props.workspace.onSearch("");
              } else {
                closeSearch();
              }
            }}
          />
          <button
            type="button"
            aria-label={t("chat.workspaceFiles.desktop.closeSearch")}
            onClick={closeSearch}
          >
            <Icon name="x" />
          </button>
        </label>
        <ActivityMenu workspace={props.workspace} filters={filters()} filter={filter()} />
      </div>
      <Show when={props.workspace.error}>
        <div class="workspace-desktop__notice">
          <div role="alert">{props.workspace.error}</div>
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.workspace.loading}
            onClick={() => props.workspace.onRetry()}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <Show when={props.workspace.loading && !props.workspace.list}>
        <PanelLoadingSkeleton variant="files" label={t("chat.workspaceFiles.loading")} />
      </Show>
      <div
        class="workspace-desktop__results"
        hidden={!navigation()?.searchOpen}
        role="list"
        aria-label={t("chat.workspaceFiles.searchResults")}
      >
        <For each={searchResults()} keyed={(file) => file.key}>
          {(file) => <RailRow file={file()} workspace={props.workspace} searching />}
        </For>
        <Show
          when={
            navigation()?.treeVisible !== false &&
            navigation()?.searchOpen &&
            Boolean(props.workspace.browserSearch.trim()) &&
            props.workspace.transcriptAttachments
          }
        >
          {(source) => (
            <WorkspaceTranscriptAttachments
              source={source()}
              query={props.workspace.browserSearch}
              presentation="desktop"
              renderName={(name) => <WorkspaceFilename name={name} />}
            />
          )}
        </Show>
        <Show when={searchTruncated()}>
          <div class="workspace-desktop__notice" role="status">
            {t("chat.workspaceFiles.truncated")}
          </div>
        </Show>
        <Show
          when={
            Boolean(props.workspace.browserSearch.trim()) &&
            !props.workspace.loading &&
            !searchTruncated() &&
            !searchResults().length &&
            !attachmentSearchVisible()
          }
        >
          <div class="workspace-desktop__notice" role="status">
            {t("chat.workspaceFiles.noSearchResults")}
          </div>
        </Show>
      </div>
      <div class="workspace-desktop__catalog" hidden={navigation()?.searchOpen}>
        <Show when={sessionFiles().length > 0 || attachmentsVisible()}>
          <WorkspaceGroup
            label={t("chat.workspaceFiles.desktop.sessionFiles")}
            expanded={navigation()?.sessionExpanded !== false}
            onToggle={() =>
              props.workspace.onSessionExpandedChange?.(navigation()?.sessionExpanded === false)
            }
            class="workspace-desktop__session"
          >
            <div
              class="workspace-desktop__session-scroll"
              role="list"
              ref={(element) => {
                setSessionScroll(element);
                element.scrollTop = navigation()?.sessionScroll ?? 0;
              }}
              onScroll={(event) =>
                props.workspace.onNavigationScroll?.("session", event.currentTarget.scrollTop)
              }
            >
              <For each={sessionFiles()} keyed={(file) => file.key}>
                {(file) => <RailRow file={file()} workspace={props.workspace} />}
              </For>
              <Show
                when={
                  navigation()?.treeVisible !== false &&
                  navigation()?.sessionExpanded !== false &&
                  !navigation()?.searchOpen &&
                  attachmentsVisible() &&
                  props.workspace.transcriptAttachments
                }
              >
                {(source) => (
                  <WorkspaceTranscriptAttachments
                    source={source()}
                    query=""
                    presentation="desktop"
                    renderName={(name) => <WorkspaceFilename name={name} />}
                  />
                )}
              </Show>
            </div>
          </WorkspaceGroup>
        </Show>
        <Show when={projectVisible()}>
          <div
            class="workspace-desktop__project-scroll"
            ref={(element) => {
              setTreeScroll(element);
              element.scrollTop = navigation()?.treeScroll ?? 0;
            }}
            onScroll={(event) =>
              props.workspace.onNavigationScroll?.("tree", event.currentTarget.scrollTop)
            }
          >
            <WorkspaceGroup
              label={
                props.workspace.folderView
                  ? undefined
                  : root().split("/").at(-1) || t("chat.workspaceFiles.browser")
              }
              animate
              active={navigation()?.treeVisible !== false && !navigation()?.searchOpen}
              expanded={expanded().includes(root())}
              onToggle={() => props.workspace.onToggleDirectory?.(root())}
            >
              <div role="list">
                <For each={childrenByPath().get(root()) ?? []} keyed={(row) => row.key}>
                  {(row) => (
                    <DirectoryBranch
                      row={row()}
                      workspace={props.workspace}
                      childrenByPath={childrenByPath()}
                      depth={0}
                    />
                  )}
                </For>
              </div>
              <Show when={directoryBrowser(root())?.truncated}>
                <div class="workspace-desktop__notice" role="status">
                  {t("chat.workspaceFiles.truncated")}
                </div>
              </Show>
            </WorkspaceGroup>
          </div>
        </Show>
        <Show
          when={
            props.workspace.list &&
            !props.workspace.loading &&
            !sessionFiles().length &&
            !attachmentsVisible() &&
            !childrenByPath().get(root())?.length &&
            expanded().includes(root())
          }
        >
          <div class="workspace-desktop__notice" role="status">
            {t("chat.workspaceFiles.noBrowserFiles")}
          </div>
        </Show>
      </div>
    </aside>
  );
}
