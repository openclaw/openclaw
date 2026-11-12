import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createProjection,
  createSignal,
  createUniqueId,
  Errored,
  For,
  isPending,
  Loading,
  Show,
  useContext,
} from "solid-js";
import {
  SESSION_FILES_DISPLAY_DEFAULTS,
  type SessionFilesDisplay,
} from "../../../app/settings-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { createPendingFocus } from "../../../lib/reactive/pending-focus.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import {
  createTranscriptAttachmentsView,
  TranscriptAttachmentRow,
  WorkspaceTranscriptAttachments,
} from "./chat-session-workspace-attachments.tsx";
import { WorkspaceBreadcrumb } from "./chat-session-workspace-breadcrumb.tsx";
import {
  projectWorkspaceCatalog,
  workspaceCatalogChildren,
  workspaceCatalogFilters,
  workspaceCatalogSearch,
  workspaceSessionFiles,
} from "./chat-session-workspace-catalog.ts";
import { createSessionWorkspaceRead } from "./chat-session-workspace-read.ts";
import { RailRow, WorkspaceFilename, WorkspaceRows } from "./chat-session-workspace-row.tsx";
import {
  orderSessionFiles,
  type SessionFileEntry,
} from "./chat-session-workspace-session-files.ts";
import type { SessionWorkspaceFilter } from "./chat-sidebar-content-types.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import { hasTranscriptAttachments } from "./chat-transcript-attachments.ts";
import "../../../styles/session-panel-rail.css";
import "./chat-session-workspace-desktop.css";
import { FileDisclosure } from "./file-disclosure.tsx";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

function WorkspaceGroup(props: {
  label?: string;
  expanded: boolean;
  onToggle: () => void;
  children: JSX.Element;
  class?: string;
  animate?: boolean;
  active?: boolean;
  contentRef?: (element: HTMLElement) => void;
}) {
  const [instant, setInstant] = createSignal(true);
  return (
    <section class={props.class} ref={(element) => props.contentRef?.(element)}>
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
          <span ref={createTextOverflow(() => props.label)} title={props.label}>
            {props.label}
          </span>
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
        <FileDisclosure
          variant="folder"
          open={props.expanded}
          active={props.active !== false}
          instant={instant()}
        >
          {props.children}
        </FileDisclosure>
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
                <StrokeIcon aria-hidden="true">
                  <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
                  <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
                  <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
                </StrokeIcon>
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

const sessionFile = (entry: SessionFileEntry) => (entry.kind === "file" ? entry.file : undefined);
const sessionAttachment = (entry: SessionFileEntry) =>
  entry.kind === "attachment" ? entry.entry : undefined;

function SessionFilesDisplayMenu(props: {
  display: SessionFilesDisplay;
  onChange: (display: Partial<SessionFilesDisplay>) => void;
}) {
  const id = createUniqueId();
  const views = [
    ["list", "list", "viewList"],
    ["grid", "layoutGrid", "viewGrid"],
  ] as const;
  const sorts = [
    ["default", "sortDefault"],
    ["date", "sortDate"],
    ["name", "sortName"],
    ["type", "sortType"],
  ] as const;
  const heading = (key: "view" | "sortBy") => (
    <div class="oc-menu-heading">
      <span class="oc-menu-heading__label">{t(`chat.workspaceFiles.display.${key}`)}</span>
    </div>
  );
  // Entries hold JSX; build them under this owner, not inside the menu's lazy reads.
  const items = createMemo<MenuEntry[]>(() => [
    { kind: "content", id: "view-heading", content: heading("view") },
    ...views.map(([view, icon, key]) => ({
      id: `view:${view}`,
      label: t(`chat.workspaceFiles.display.${key}`),
      type: "radio" as const,
      checked: props.display.view === view,
      icon: <Icon name={icon} />,
    })),
    { kind: "content", id: "sort-separator", content: <div role="separator" /> },
    { kind: "content", id: "sort-heading", content: heading("sortBy") },
    ...sorts.map(([sort, key]) => ({
      id: `sort:${sort}`,
      label: t(`chat.workspaceFiles.display.${key}`),
      type: "radio" as const,
      checked: props.display.sort === sort,
    })),
  ]);
  return (
    <Menu
      id={`workspace-session-display-${id}`}
      label={t("chat.workspaceFiles.display.label")}
      panelClass="workspace-desktop__menu"
      triggerClass="session-panel-rail__button"
      triggerAttributes={{ title: t("chat.workspaceFiles.display.label") }}
      trigger={<Icon name={props.display.view === "grid" ? "layoutGrid" : "list"} />}
      items={items()}
      onSelect={(item) => {
        const view = views.find(([candidate]) => item.id === `view:${candidate}`)?.[0];
        const sort = sorts.find(([candidate]) => item.id === `sort:${candidate}`)?.[0];
        if (view) {
          props.onChange({ view });
        } else if (sort) {
          props.onChange({ sort });
        }
      }}
    />
  );
}

export function DesktopWorkspaceContents(props: { workspace: SessionWorkspaceProps }) {
  const presented = useContext(ContentPresentation);
  const sessionDisplay = () =>
    props.workspace.sessionFilesDisplay ?? SESSION_FILES_DISPLAY_DEFAULTS;
  const { read, scope } = createSessionWorkspaceRead(() => props.workspace);
  let searchField: HTMLInputElement | undefined;
  const searchValue = liveValue(() => props.workspace.browserSearch);
  let searchButton: HTMLButtonElement | undefined;
  const [treeScroll, setTreeScroll] = createSignal<HTMLDivElement>();
  const [treeContent, setTreeContent] = createSignal<HTMLElement>();
  const [sessionScroll, setSessionScroll] = createSignal<HTMLDivElement>();
  // Directory records mutate in place; retain only the immutable browser inputs
  // so navigation publications do not rebuild and re-sort the complete tree.
  const catalogInputs = createMemo(
    () => ({
      list: props.workspace.list,
      directories: Object.fromEntries(
        Object.entries(props.workspace.directories ?? {}).map(([path, directory]) => [
          path,
          { browser: directory.browser },
        ]),
      ),
    }),
    {
      equals: (previous, next) => {
        const paths = Object.keys(next.directories);
        return (
          previous.list === next.list &&
          Object.keys(previous.directories).length === paths.length &&
          paths.every(
            (path) => previous.directories[path]?.browser === next.directories[path]?.browser,
          )
        );
      },
    },
  );
  const catalog = createMemo(() =>
    projectWorkspaceCatalog(catalogInputs().list, catalogInputs().directories),
  );
  // Search replies replace the list while loaded directory rows usually stay unchanged.
  const projectRows = createProjection(() => [...catalog().project.values()], [], { key: "key" });
  const projectByPath = createMemo(
    () => new Map(projectRows.map((row) => [row.workspacePath ?? row.path, row])),
  );
  const filters = createMemo(() =>
    props.workspace.folderView
      ? workspaceCatalogFilters(
          { project: projectByPath(), session: catalog().session },
          props.workspace.browserPath,
        )
      : catalog().filters,
  );
  const filter = createMemo(() =>
    filters().includes(props.workspace.filter) ? props.workspace.filter : "all",
  );
  const navigation = () => props.workspace.navigation;
  const root = () => props.workspace.browserPath;
  const expanded = () => navigation()?.expandedPaths ?? [""];
  const directoryBrowser = (path: string) =>
    props.workspace.directories?.[path]?.browser ??
    (!props.workspace.list?.browser?.search && props.workspace.list?.browser?.path === path
      ? props.workspace.list.browser
      : undefined);
  const childrenByPath = createMemo(() =>
    workspaceCatalogChildren({ project: projectByPath() }, filter()),
  );
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
  const sessionAttachments = createTranscriptAttachmentsView(
    () =>
      presented() &&
      navigation()?.treeVisible !== false &&
      navigation()?.sessionExpanded !== false &&
      !navigation()?.searchOpen &&
      attachmentsVisible()
        ? props.workspace.transcriptAttachments
        : undefined,
    () => "",
  );
  const sessionEntries = createMemo(() =>
    orderSessionFiles(sessionFiles(), sessionAttachments.entries(), sessionDisplay().sort),
  );
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
  // Restore on navigation/reveal, not every snapshot: native scroll events can
  // reach the owner after a folder click has already published its snapshot.
  const savedScroll = createMemo(() => ({
    tree: navigation()?.treeScroll,
    session: navigation()?.sessionScroll,
  }));
  const closeSearch = () => {
    restoreSearchFocus = true;
    props.workspace.onSearchOpenChange?.(false);
  };
  const Contents = (content: { pending: boolean }) => {
    createScrollPosition(() => ({
      restore: {
        identity: [
          scope(),
          treeScroll(),
          navigation()?.searchOpen,
          navigation()?.treeVisible,
          savedScroll().tree,
        ],
        target: treeScroll(),
        top: savedScroll().tree ?? 0,
      },
    }));
    createScrollPosition(() => ({
      restore: {
        identity: [
          scope(),
          sessionScroll(),
          navigation()?.searchOpen,
          navigation()?.treeVisible,
          navigation()?.sessionExpanded,
          savedScroll().session,
        ],
        target: sessionScroll(),
        top: savedScroll().session ?? 0,
      },
    }));
    return (
      <>
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
            <div class="workspace-desktop__notice">
              <div role="status">{t("chat.workspaceFiles.searchIncomplete")}</div>
              <button type="button" class="btn btn--sm" onClick={closeSearch}>
                {t("chat.workspaceFiles.browseFiles")}
              </button>
            </div>
          </Show>
          <Show
            when={
              Boolean(props.workspace.browserSearch.trim()) &&
              !content.pending &&
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
                class={[
                  "workspace-desktop__session-scroll",
                  { "workspace-desktop__session-scroll--grid": sessionDisplay().view === "grid" },
                ]}
                role="list"
                aria-label={t("chat.workspaceFiles.desktop.sessionFiles")}
                ref={setSessionScroll}
                onScroll={(event) =>
                  props.workspace.onNavigationScroll?.("session", event.currentTarget.scrollTop)
                }
              >
                <sessionAttachments.Lifetime />
                <For each={sessionEntries()} keyed={(entry) => entry.key}>
                  {(entry) => (
                    <Show
                      when={sessionFile(entry())}
                      fallback={
                        <Show when={sessionAttachment(entry())}>
                          {(attachment) => (
                            <TranscriptAttachmentRow
                              entry={attachment()}
                              presentation="desktop"
                              view={sessionDisplay().view}
                              renderName={(name) => <WorkspaceFilename name={name} />}
                            />
                          )}
                        </Show>
                      }
                    >
                      {(file) => (
                        <RailRow
                          file={file()}
                          workspace={props.workspace}
                          view={sessionDisplay().view}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </div>
              <Show when={sessionAttachments.notice()}>
                {(message) => (
                  <div
                    role={sessionAttachments.source()?.error ? "alert" : "status"}
                    class="workspace-desktop__notice"
                  >
                    {message()}
                  </div>
                )}
              </Show>
            </WorkspaceGroup>
          </Show>
          <Show when={projectVisible()}>
            <div
              class="workspace-desktop__project-scroll"
              ref={setTreeScroll}
              onScroll={(event) =>
                props.workspace.onNavigationScroll?.("tree", event.currentTarget.scrollTop)
              }
            >
              <WorkspaceGroup
                contentRef={setTreeContent}
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
                <WorkspaceRows
                  rows={childrenByPath().get(root()) ?? []}
                  workspace={props.workspace}
                  childrenByPath={childrenByPath()}
                  depth={0}
                  viewport={treeScroll()}
                  content={treeContent()}
                  active={
                    navigation()?.treeVisible !== false &&
                    !navigation()?.searchOpen &&
                    expanded().includes(root())
                  }
                />
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
              !content.pending &&
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
      </>
    );
  };
  const WorkspaceLoading = () => (
    <PanelLoadingSkeleton variant="files" label={t("chat.workspaceFiles.loading")} />
  );
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
        <Show
          when={
            !props.workspace.folderView &&
            !navigation()?.searchOpen &&
            (sessionFiles().length > 0 || attachmentsVisible())
          }
        >
          <div class="session-panel-rail__group">
            <SessionFilesDisplayMenu
              display={sessionDisplay()}
              onChange={(display) => props.workspace.onSessionFilesDisplayChange?.(display)}
            />
          </div>
        </Show>
      </div>
      <Loading on={scope()} fallback={<WorkspaceLoading />}>
        <Errored
          fallback={(error, reset) => (
            <div class="workspace-desktop__notice">
              <div role="alert">{formatUiError(error())}</div>
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  props.workspace.onRetry();
                  reset();
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          )}
        >
          {read()}
        </Errored>
        <Show when={props.workspace.list || !isPending(read)} fallback={<WorkspaceLoading />}>
          <Contents pending={isPending(read)} />
        </Show>
      </Loading>
    </aside>
  );
}
