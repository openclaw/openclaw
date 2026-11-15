import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createProjection,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  Show,
  useContext,
} from "solid-js";
import { SESSION_FILES_DISPLAY_DEFAULTS } from "../../../app/settings-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
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
import { ActivityMenu, SessionFilesDisplayMenu } from "./chat-session-workspace-menus.tsx";
import { createSessionWorkspaceRead } from "./chat-session-workspace-read.ts";
import { RailRow, WorkspaceFilename, WorkspaceRows } from "./chat-session-workspace-row.tsx";
import {
  orderSessionFiles,
  type SessionFileEntry,
} from "./chat-session-workspace-session-files.ts";
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

const sessionFile = (entry: SessionFileEntry) => (entry.kind === "file" ? entry.file : undefined);
const sessionAttachment = (entry: SessionFileEntry) =>
  entry.kind === "attachment" ? entry.entry : undefined;

export function DesktopWorkspaceContents(props: { workspace: SessionWorkspaceProps }) {
  const presented = useContext(ContentPresentation);
  // Catalog layout does not grant desktop reader/pinning behavior to an imported session.
  const defaultCatalog = () => props.workspace.presentation === undefined;
  const sessionDisplay = () =>
    defaultCatalog()
      ? SESSION_FILES_DISPLAY_DEFAULTS
      : (props.workspace.sessionFilesDisplay ?? SESSION_FILES_DISPLAY_DEFAULTS);
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
    projectWorkspaceCatalog(
      catalogInputs().list,
      defaultCatalog() ? {} : catalogInputs().directories,
      defaultCatalog() ? "session" : "project",
    ),
  );
  const navigation = () => props.workspace.navigation;
  // Default Files leaves catalog visibility to its panel, not desktop navigation.
  const treeVisible = () => defaultCatalog() || navigation()?.treeVisible !== false;
  const searching = () =>
    defaultCatalog() ? Boolean(props.workspace.browserSearch.trim()) : navigation()?.searchOpen;
  const root = () => props.workspace.browserPath;
  const searchResults = createMemo(() =>
    workspaceCatalogSearch(
      props.workspace.list,
      props.workspace.browserSearch,
      defaultCatalog() ? "session" : "project",
    ),
  );
  // Browser rows belong to the accepted native snapshot, not the requested query.
  // Keep their owners until the next admitted reply; session rows filter immediately.
  const projectRows = createProjection(() => [...catalog().project.values()], [], { key: "key" });
  const projectByPath = createMemo(
    () => new Map(projectRows.map((row) => [row.workspacePath ?? row.path, row])),
  );
  const filters = createMemo(() =>
    defaultCatalog()
      ? workspaceCatalogFilters({ project: new Map(), session: catalog().session })
      : props.workspace.folderView
        ? workspaceCatalogFilters(
            { project: projectByPath(), session: catalog().session },
            props.workspace.browserPath,
          )
        : catalog().filters,
  );
  const filter = createMemo(() =>
    filters().includes(props.workspace.filter) ? props.workspace.filter : "all",
  );
  const expanded = () => navigation()?.expandedPaths ?? [""];
  const directoryBrowser = (path: string) =>
    (!defaultCatalog() ? props.workspace.directories?.[path]?.browser : undefined) ??
    ((defaultCatalog() || !props.workspace.list?.browser?.search) &&
    props.workspace.list?.browser?.path === path
      ? props.workspace.list.browser
      : undefined);
  const childrenByPath = createMemo(() =>
    workspaceCatalogChildren(
      { project: projectByPath() },
      filter(),
      defaultCatalog() ? root() : undefined,
    ),
  );
  const sessionFiles = createMemo(() =>
    props.workspace.folderView
      ? []
      : workspaceSessionFiles(
          defaultCatalog() && searching()
            ? { ...catalog(), session: searchResults().filter((file) => file.origin === "session") }
            : catalog(),
          filter(),
        ),
  );
  const searchTruncated = () => {
    const query = props.workspace.browserSearch.trim().toLowerCase();
    const browser = props.workspace.list?.browser;
    return Boolean(
      (!defaultCatalog() || filter() === "all") &&
      query &&
      browser?.truncated &&
      browser.search?.toLowerCase() === query,
    );
  };
  const attachmentsVisible = () =>
    !defaultCatalog() &&
    !props.workspace.folderView &&
    filter() === "all" &&
    hasTranscriptAttachments(props.workspace.transcriptAttachments);
  const sessionAttachments = createTranscriptAttachmentsView(
    () =>
      presented() &&
      treeVisible() &&
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
    !defaultCatalog() &&
    hasTranscriptAttachments(props.workspace.transcriptAttachments, props.workspace.browserSearch);
  const projectVisible = () =>
    filter() !== "artifacts" &&
    (!defaultCatalog() || filter() === "all") &&
    Boolean(directoryBrowser(root()) || props.workspace.list?.browser || catalog().project.size);
  const unavailableFolder = () =>
    defaultCatalog() &&
    props.workspace.list !== null &&
    !props.workspace.browserSearch.trim() &&
    root() !== "" &&
    !props.workspace.list?.browser;
  const parentPath = () =>
    directoryBrowser(root())?.parentPath ??
    (unavailableFolder() ? root().slice(0, Math.max(0, root().lastIndexOf("/"))) : null);
  let restoreSearchFocus = false;
  // Focus after visibility commits, only when search changes state.
  createPendingFocus(() => Boolean(navigation()?.searchOpen), {
    requested: (open, previous) => open !== (previous ?? false),
    focus: (open) => {
      if (open) {
        searchField?.focus({ preventScroll: true });
      } else if (restoreSearchFocus) {
        restoreSearchFocus = false;
        (defaultCatalog() ? searchField : searchButton)?.focus({ preventScroll: true });
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
  const SearchNotices = (notice: { pending: boolean }) => (
    <>
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
          (!defaultCatalog() || props.workspace.list !== null) &&
          !notice.pending &&
          !searchTruncated() &&
          (defaultCatalog()
            ? !sessionFiles().length && (filter() !== "all" || !projectRows.length)
            : !searchResults().length && !attachmentSearchVisible())
        }
      >
        <div class="workspace-desktop__notice" role="status">
          {t("chat.workspaceFiles.noSearchResults")}
        </div>
      </Show>
    </>
  );
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
          hidden={defaultCatalog() || !searching()}
          role="list"
          aria-label={t("chat.workspaceFiles.searchResults")}
        >
          <For each={defaultCatalog() ? [] : searchResults()} keyed={(file) => file.key}>
            {(file) => <RailRow file={file()} workspace={props.workspace} searching />}
          </For>
          <Show
            when={
              !defaultCatalog() &&
              treeVisible() &&
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
          <Show when={!defaultCatalog()}>
            <SearchNotices pending={content.pending} />
          </Show>
        </div>
        <div class="workspace-desktop__catalog" hidden={!defaultCatalog() && searching()}>
          <Show when={sessionFiles().length > 0 || attachmentsVisible()}>
            <WorkspaceGroup
              label={
                defaultCatalog() && searching()
                  ? undefined
                  : t("chat.workspaceFiles.desktop.sessionFiles")
              }
              expanded={
                (defaultCatalog() && searching()) || navigation()?.sessionExpanded !== false
              }
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
          <Show when={defaultCatalog() && !searching() && parentPath() !== null}>
            <button
              type="button"
              class="workspace-desktop__notice"
              aria-label=".."
              onClick={() => props.workspace.onBrowsePath(parentPath() ?? "")}
            >
              .. · {t("chat.workspaceFiles.parentFolder")}
            </button>
          </Show>
          <Show when={unavailableFolder()}>
            <div class="workspace-desktop__notice" role="status">
              {t("chat.workspaceFiles.folderUnavailable")}
            </div>
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
                  props.workspace.folderView || (defaultCatalog() && searching())
                    ? undefined
                    : root().split("/").at(-1) || t("chat.workspaceFiles.browser")
                }
                animate
                active={treeVisible() && (defaultCatalog() || !searching())}
                expanded={(defaultCatalog() && searching()) || expanded().includes(root())}
                onToggle={() => props.workspace.onToggleDirectory?.(root())}
              >
                <Show when={defaultCatalog() && props.workspace.list?.browser?.search}>
                  {(query) => (
                    <div class="workspace-desktop__notice">
                      {t("chat.workspaceFiles.searchResults")}: {query()}
                    </div>
                  )}
                </Show>
                <WorkspaceRows
                  rows={childrenByPath().get(root()) ?? []}
                  workspace={props.workspace}
                  childrenByPath={childrenByPath()}
                  depth={0}
                  viewport={treeScroll()}
                  content={treeContent()}
                  active={
                    treeVisible() &&
                    (defaultCatalog() || !searching()) &&
                    ((defaultCatalog() && searching()) || expanded().includes(root()))
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
              !unavailableFolder() &&
              (!defaultCatalog() || !searching()) &&
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
          <Show when={defaultCatalog() && searching()}>
            <SearchNotices pending={content.pending} />
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
      class={[
        "workspace-desktop",
        {
          "workspace-desktop--default": defaultCatalog(),
          "workspace-desktop--session-only": !projectVisible(),
        },
      ]}
      aria-label={t("chat.workspaceFiles.label")}
      hidden={!treeVisible()}
    >
      <Show when={defaultCatalog() && props.workspace.list?.root}>
        {(path) => (
          <div class="workspace-desktop__notice workspace-desktop__path" title={path()}>
            {path()}
          </div>
        )}
      </Show>
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
        <div
          class="session-panel-rail__group"
          hidden={defaultCatalog() || navigation()?.searchOpen}
        >
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
        <label
          class="workspace-desktop__search"
          hidden={!defaultCatalog() && !navigation()?.searchOpen}
        >
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
              if (defaultCatalog() || event.key !== "Escape") {
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
            hidden={defaultCatalog()}
            aria-label={t("chat.workspaceFiles.desktop.closeSearch")}
            onClick={closeSearch}
          >
            <Icon name="x" />
          </button>
        </label>
        <ActivityMenu workspace={props.workspace} filters={filters()} filter={filter()} />
        <Show
          when={
            !defaultCatalog() &&
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
