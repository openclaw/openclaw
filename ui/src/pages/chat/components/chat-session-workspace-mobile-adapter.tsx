import {
  createSignal,
  createMemo,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { foldSearchCase } from "../../../../../src/shared/search-case.js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { fileKindForPath } from "../../../components/file-kind.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { formatByteSize } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { WorkspaceTranscriptAttachments } from "./chat-session-workspace-attachments.tsx";
import { createSessionWorkspaceRead } from "./chat-session-workspace-read.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import { hasTranscriptAttachments } from "./chat-transcript-attachments.ts";
import "./chat-session-workspace-mobile.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

type File = SessionWorkspaceListResult["files"][number];

type Artifact = NonNullable<SessionWorkspaceListResult["artifacts"]>[number];
type BrowserEntry = NonNullable<SessionWorkspaceListResult["browser"]>["entries"][number];

/** Already filtered by the workspace owner; this view does not search or sort another catalog. */
type SessionWorkspaceMobileGroup = { expanded: boolean } & (
  | { kind: "changed" | "read"; files: readonly File[] }
  | { kind: "artifacts"; artifacts: readonly Artifact[] }
  | { kind: "workspace"; entries: readonly BrowserEntry[]; truncated: boolean }
);

type SessionWorkspaceMobileLocation =
  | { kind: "root" }
  | {
      kind: "folder";
      /** Includes the workspace root; paths are owner-issued navigation targets. */
      breadcrumbs: readonly { path: string; label: string }[];
      backLabel: string;
      searchLabel: string;
      onBack: () => void;
    };

type SessionWorkspaceMobileStatus =
  | { kind: "ready"; refreshing: boolean }
  | { kind: "loading" }
  | { kind: "empty"; heading: string; description: string }
  | { kind: "error" | "unavailable"; message: string; onRetry?: () => void };

const FILTERS = ["all", "changed", "read", "artifacts"] as const;
const GROUP_LABELS = {
  changed: "chat.workspaceFiles.changed",
  read: "chat.workspaceFiles.read",
  artifacts: "chat.workspaceFiles.desktop.sessionFiles",
  workspace: "chat.workspaceFiles.files",
} as const;

function groupCount(group: SessionWorkspaceMobileGroup): number {
  if (group.kind === "workspace") {
    return group.entries.length;
  }
  if (group.kind === "artifacts") {
    return group.artifacts.length;
  }
  return group.files.length;
}

function parentDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? "" : path.slice(0, separator);
}

function fileIcon(path: string): IconName {
  const kind = fileKindForPath(path);
  return kind === "image"
    ? "image"
    : kind === "code" || kind === "component"
      ? "fileCode"
      : "fileText";
}

function MobileFileName(props: { name: string; directory?: boolean }) {
  const split = createMemo(() => {
    const dot = props.directory ? -1 : props.name.lastIndexOf(".");
    return dot > 0 && dot < props.name.length - 1
      ? [props.name.slice(0, dot), props.name.slice(dot)]
      : [props.name, ""];
  });
  return (
    <span class="chat-workspace-mobile__name">
      <span
        ref={createTextOverflow(() => split()[0])}
        class="chat-workspace-mobile__stem"
        title={props.name}
      >
        {split()[0]}
      </span>
      <span class="chat-workspace-mobile__extension">{split()[1]}</span>
    </span>
  );
}

function MobileFileRow(props: {
  name: string;
  path: string;
  directory?: boolean;
  parent?: string;
  size?: number;
  missing?: boolean;
  icon: IconName;
  onOpen: () => void;
}) {
  return (
    <li class="chat-workspace-mobile__item">
      <button
        type="button"
        class="chat-workspace-mobile__row"
        aria-label={props.path || props.name}
        onClick={() => props.onOpen()}
      >
        <Icon name={props.icon} class="chat-workspace-mobile__file-icon" />
        <span class="chat-workspace-mobile__identity">
          <MobileFileName name={props.name} directory={props.directory} />
          <Show when={props.parent}>
            <span
              ref={createTextOverflow(() => props.parent)}
              class="chat-workspace-mobile__directory"
              title={props.parent}
            >
              {props.parent}
            </span>
          </Show>
        </span>
        <Show when={props.missing}>
          <span class="chat-workspace-mobile__meta">{t("chat.workspaceFiles.missing")}</span>
        </Show>
        <Show when={props.size !== undefined && !props.missing}>
          <span class="chat-workspace-mobile__meta">
            {formatByteSize(props.size ?? 0, {
              style: "legacy-binary",
              maxUnit: "mega",
              separator: " ",
              fractionDigits: (value, unit) =>
                unit === "byte" ? null : Math.round(value * 10) % 10 ? 1 : 0,
            })}
          </span>
        </Show>
        <Icon name="chevronRight" class="chat-workspace-mobile__chevron" />
      </button>
    </li>
  );
}

function MobileFolderHeader(props: {
  location: Extract<SessionWorkspaceMobileLocation, { kind: "folder" }>;
  onBrowsePath: SessionWorkspaceProps["onBrowsePath"];
}) {
  const [trail, setTrail] = createSignal<HTMLDivElement>();
  // Each folder destination reveals its current crumb without scrolling the outer host.
  createScrollPosition(() => ({
    restore: {
      identity: [trail(), props.location.breadcrumbs.at(-1)?.path],
      target: trail(),
      left: "end",
    },
  }));
  return (
    <div class="chat-workspace-mobile__folder-header">
      <button
        type="button"
        class="chat-workspace-mobile__back"
        aria-label={props.location.backLabel}
        onClick={() => props.location.onBack()}
      >
        <Icon name="chevronLeft" />
      </button>
      <div class="chat-workspace-mobile__breadcrumbs" ref={setTrail}>
        <For each={props.location.breadcrumbs} keyed={(crumb) => crumb.path}>
          {(crumb, index) => (
            <>
              <Show when={index() > 0}>
                <Icon name="chevronRight" />
              </Show>
              <button
                type="button"
                aria-current={
                  index() === props.location.breadcrumbs.length - 1 ? "location" : undefined
                }
                onClick={() => props.onBrowsePath(crumb().path)}
              >
                {crumb().label}
              </button>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

function MobileGroupRows(props: {
  group: SessionWorkspaceMobileGroup;
  folder: boolean;
  search: string;
  onBrowsePath: SessionWorkspaceProps["onBrowsePath"];
  onBrowseFiles: () => void;
  onOpenFileInsideFiles: SessionWorkspaceProps["onOpenFile"];
  onOpenArtifactInsideFiles: SessionWorkspaceProps["onOpenArtifact"];
}) {
  const files = createMemo(() => {
    const group = props.group;
    return group.kind === "changed" || group.kind === "read" ? group.files : [];
  });
  const artifacts = createMemo(() => {
    const group = props.group;
    return group.kind === "artifacts" ? group.artifacts : [];
  });
  const workspace = createMemo(() => {
    const group = props.group;
    return group.kind === "workspace" ? group : undefined;
  });
  return (
    <>
      <ul class="chat-workspace-mobile__list">
        <For each={files()} keyed={(file) => file.path}>
          {(file) => (
            <MobileFileRow
              name={file().name}
              path={file().path}
              parent={parentDirectory(file().path)}
              missing={file().missing}
              icon={fileIcon(file().path)}
              onOpen={() => props.onOpenFileInsideFiles(file().path, "session")}
            />
          )}
        </For>
        <For each={artifacts()} keyed={(artifact) => artifact.id}>
          {(artifact) => (
            <MobileFileRow
              name={artifact().title}
              path={artifact().title}
              icon={artifact().mimeType?.startsWith("image/") ? "image" : "paperclip"}
              onOpen={() => props.onOpenArtifactInsideFiles(artifact().id)}
            />
          )}
        </For>
        <For each={workspace()?.entries} keyed={(entry) => entry.path}>
          {(entry) => (
            <MobileFileRow
              name={entry().name}
              path={entry().path}
              directory={entry().kind === "directory"}
              parent={props.search ? parentDirectory(entry().path) : undefined}
              size={props.folder && entry().kind === "file" ? entry().size : undefined}
              icon={entry().kind === "directory" ? "folder" : fileIcon(entry().path)}
              onOpen={() =>
                entry().kind === "directory"
                  ? props.onBrowsePath(entry().path)
                  : props.onOpenFileInsideFiles(entry().path, "workspace")
              }
            />
          )}
        </For>
      </ul>
      <Show when={workspace()?.truncated}>
        <div class="chat-workspace-mobile__notice">
          <div role="status">
            {t(
              props.search.trim()
                ? "chat.workspaceFiles.searchIncomplete"
                : "chat.workspaceFiles.truncated",
            )}
          </div>
          <Show when={props.search.trim()}>
            <button type="button" class="btn" onClick={() => props.onBrowseFiles()}>
              {t("chat.workspaceFiles.browseFiles")}
            </button>
          </Show>
        </div>
      </Show>
    </>
  );
}

export function MobileWorkspaceContents(props: {
  workspace: SessionWorkspaceProps & {
    onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  };
}) {
  const { read, scope } = createSessionWorkspaceRead(() => props.workspace);
  const sessionKey = createMemo(() => props.workspace.sessionKey);
  const attachments = createMemo(() => props.workspace.transcriptAttachments);
  const list = createMemo(() => props.workspace.list);
  const path = createMemo(() => props.workspace.browserPath);
  const query = createMemo(() => props.workspace.browserSearch);
  const selectedFilter = createMemo(() => props.workspace.filter);
  const connected = createMemo(() => props.workspace.connected);
  const cachedBrowser = createMemo(() => props.workspace.directories?.[path()]?.browser);
  const expanded = {
    changed: createMemo(() => props.workspace.mobileNavigation?.expandedGroups.changed ?? true),
    read: createMemo(() => props.workspace.mobileNavigation?.expandedGroups.read ?? false),
    artifacts: createMemo(
      () => props.workspace.mobileNavigation?.expandedGroups.artifacts ?? false,
    ),
    workspace: createMemo(() => props.workspace.mobileNavigation?.expandedGroups.workspace ?? true),
  };
  const onRetry = () => props.workspace.onRetry?.();
  /** Mobile keeps native groups; desktop's tree is a different presentation of the same owner. */
  const model = createMemo(() => {
    const workspace = {
      sessionKey: sessionKey(),
      list: list(),
      transcriptAttachments: attachments(),
      browserPath: path(),
      browserSearch: query(),
      filter: selectedFilter(),
      connected: connected(),
      cachedBrowser: cachedBrowser(),
      onRetry,
      mobileNavigation: {
        expandedGroups: {
          changed: expanded.changed(),
          read: expanded.read(),
          artifacts: expanded.artifacts(),
          workspace: expanded.workspace(),
        },
        scrollTop: 0,
      },
    };
    const workspaceList = workspace.list;
    const searchQuery = workspace.browserSearch.trim();
    // The server echo check below stays byte-exact; local candidate matching compares NFC.
    const matchQuery = foldSearchCase(searchQuery).normalize("NFC");
    const browserPath = workspace.browserPath;
    const listed = workspaceList?.browser;
    const browser = searchQuery
      ? listed?.search?.trim().toLowerCase() === searchQuery.toLowerCase()
        ? listed
        : undefined
      : listed && !listed.search && listed.path === browserPath
        ? listed
        : workspace.cachedBrowser;
    const matches = (...values: (string | undefined)[]) =>
      !searchQuery ||
      values.some(
        (value) =>
          value !== undefined && foldSearchCase(value).normalize("NFC").includes(matchQuery),
      );
    const groups: SessionWorkspaceMobileGroup[] = [];
    const expandedGroups = workspace.mobileNavigation?.expandedGroups;
    if (!browserPath) {
      for (const kind of ["changed", "read"] as const) {
        if (workspace.filter !== "all" && workspace.filter !== kind) {
          continue;
        }
        const files = new Map<string, File>();
        for (const file of workspaceList?.files ?? []) {
          if (
            file.kind !== (kind === "changed" ? "modified" : "read") ||
            !matches(file.path, file.workspacePath, file.name)
          ) {
            continue;
          }
          const key =
            file.workspacePath === undefined
              ? `file:${file.path}`
              : sessionWorkspaceFileKey(
                  workspace.sessionKey,
                  workspaceList?.root,
                  file.workspacePath,
                );
          if (!files.has(key)) {
            files.set(key, file);
          }
        }
        if (files.size) {
          groups.push({
            kind,
            files: [...files.values()],
            expanded: expandedGroups?.[kind] ?? kind === "changed",
          });
        }
      }
      const artifacts =
        workspaceList?.artifacts?.filter((artifact) => matches(artifact.title)) ?? [];
      if (artifacts.length && (workspace.filter === "all" || workspace.filter === "artifacts")) {
        groups.push({ kind: "artifacts", artifacts, expanded: expandedGroups?.artifacts ?? false });
      }
    }
    if (browser && (browserPath || workspace.filter === "all")) {
      // Native search is bounded and global. Restrict real results to this folder;
      // retain its truncation warning instead of claiming a complete subtree search.
      const entries =
        browserPath && searchQuery
          ? browser.entries.filter((entry) => entry.path.startsWith(`${browserPath}/`))
          : browser.entries;
      if (entries.length || browser.truncated) {
        groups.push({
          kind: "workspace",
          entries,
          truncated: browser.truncated === true,
          expanded: expandedGroups?.workspace ?? true,
        });
      }
    }
    let status: SessionWorkspaceMobileStatus;
    if (workspace.connected === false && !workspaceList) {
      status = {
        kind: "unavailable",
        message: t("chat.workspaceFiles.mobile.disconnected"),
        onRetry: workspace.onRetry,
      };
    } else if (!workspaceList || (!browser && listed && searchQuery)) {
      status = { kind: "loading" };
    } else if (
      groups.length ||
      (!browserPath &&
        workspace.filter === "all" &&
        hasTranscriptAttachments(workspace.transcriptAttachments, searchQuery))
    ) {
      status = { kind: "ready", refreshing: false };
    } else if (!browser && (browserPath || workspace.filter === "all")) {
      status = {
        kind: "unavailable",
        message: t(
          browserPath
            ? "chat.workspaceFiles.folderUnavailable"
            : "chat.workspaceFiles.mobile.unavailable",
        ),
        onRetry: workspace.onRetry,
      };
    } else {
      status = {
        kind: "empty",
        heading: t("chat.sidePanel.files"),
        description: t(
          searchQuery ? "chat.workspaceFiles.noSearchResults" : "chat.workspaceFiles.mobile.empty",
        ),
      };
    }
    return { groups, status };
  });
  const onBrowsePath = (next: string) => props.workspace.onBrowsePath(next);
  const onBack = () => onBrowsePath(path().slice(0, Math.max(0, path().lastIndexOf("/"))));
  const location = createMemo<SessionWorkspaceMobileLocation>(() => {
    if (!path()) {
      return { kind: "root" };
    }
    const segments = path().split("/");
    return {
      kind: "folder",
      backLabel: t("chat.workspaceFiles.parentFolder"),
      onBack,
      searchLabel: t("chat.workspaceFiles.mobile.searchFolder", {
        folder: segments.at(-1) ?? path(),
      }),
      breadcrumbs: [
        { path: "", label: t("chat.workspaceFiles.root") },
        ...segments.map((label, index) => ({
          path: segments.slice(0, index + 1).join("/"),
          label,
        })),
      ],
    };
  });
  const [scrollElement, onScrollElement] = createSignal<HTMLDivElement | null>(null);
  const destination = createMemo(() => JSON.stringify([sessionKey(), path(), query()]));
  createScrollPosition(() => {
    const element = scrollElement();
    return {
      restore:
        model().status.kind === "ready"
          ? {
              identity: [destination(), element],
              target: element,
              top: props.workspace.mobileNavigation?.scrollTop ?? 0,
            }
          : undefined,
    };
  });
  const onScroll = (top: number) => {
    if (model().status.kind === "ready") {
      props.workspace.onMobileScroll?.(top);
    }
  };
  /** Controlled catalog only. The mobile host mounts the retained reader for a file destination. */
  function View(view: { status: SessionWorkspaceMobileStatus }) {
    let scroll!: HTMLDivElement;
    let content!: HTMLDivElement;
    let searchField: HTMLInputElement | undefined;
    const folderLocation = () => {
      const current = location();
      return current.kind === "folder" ? current : undefined;
    };
    const folder = () => Boolean(folderLocation());
    const searchLabel = () => folderLocation()?.searchLabel ?? t("chat.workspaceFiles.search");
    const busy = () =>
      view.status.kind === "loading" || (view.status.kind === "ready" && view.status.refreshing);
    const updateFades = () => {
      scroll.toggleAttribute("data-fade-top", scroll.scrollTop > 1);
      scroll.toggleAttribute(
        "data-fade-bottom",
        scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1,
      );
    };
    onSettled(() => {
      onScrollElement(scroll);
      const releaseScrollPort = props.workspace.onScrollPortRef?.(scroll);
      const observer = new ResizeObserver(updateFades);
      observer.observe(scroll);
      observer.observe(content);
      updateFades();
      return () => {
        observer.disconnect();
        releaseScrollPort?.();
        onScrollElement(null);
      };
    });
    return (
      <section class="chat-workspace-mobile" aria-label={t("chat.workspaceFiles.label")}>
        <div class="chat-workspace-mobile__rail">
          <Show when={folderLocation()}>
            {(currentLocation) => (
              <MobileFolderHeader location={currentLocation()} onBrowsePath={onBrowsePath} />
            )}
          </Show>
          <label class="chat-workspace-mobile__search">
            <Icon name="search" />
            <input
              type="search"
              placeholder={searchLabel()}
              aria-label={searchLabel()}
              ref={[
                liveValue(() => query()),
                (element) => {
                  searchField = element;
                },
              ]}
              onInput={(event) => props.workspace.onSearch(event.currentTarget.value)}
            />
          </label>
        </div>
        <div
          class="chat-workspace-mobile__scroll"
          ref={(element) => {
            scroll = element;
          }}
          aria-busy={busy() ? "true" : "false"}
          onScroll={() => {
            updateFades();
            onScroll(scroll.scrollTop);
          }}
        >
          <div
            class="chat-workspace-mobile__content"
            ref={(element) => {
              content = element;
            }}
          >
            <Show when={!folder()}>
              <div
                class="chat-workspace-mobile__filters"
                role="group"
                aria-label={t("chat.workspaceFiles.filters")}
              >
                <For each={FILTERS}>
                  {(filter) => (
                    <button
                      type="button"
                      aria-pressed={selectedFilter() === filter ? "true" : "false"}
                      onClick={() => props.workspace.onSetFilter(filter)}
                    >
                      {t(
                        filter === "all"
                          ? "chat.workspaceFiles.filterAll"
                          : filter === "artifacts"
                            ? "chat.workspaceFiles.desktop.sessionFiles"
                            : `chat.workspaceFiles.${filter}`,
                      )}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={view.status.kind === "loading"}>
              <PanelLoadingSkeleton variant="files" label={t("chat.workspaceFiles.loading")} />
            </Show>
            <Show
              when={
                (view.status.kind === "error" || view.status.kind === "unavailable") && view.status
              }
            >
              {(status) => (
                <div
                  class="chat-workspace-mobile__state"
                  role={status().kind === "error" ? "alert" : "status"}
                >
                  <p>{status().message}</p>
                  <Show when={status().onRetry}>
                    {(retry) => (
                      <button type="button" class="btn" onClick={() => retry()()}>
                        {t("common.retry")}
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={view.status.kind === "empty" && view.status}>
              {(status) => (
                <PanelEmptyState
                  presentation="mobile"
                  heading={status().heading}
                  description={status().description}
                  icon={<Icon name="folder" />}
                />
              )}
            </Show>
            <Show when={view.status.kind === "ready"}>
              <For each={model().groups} keyed={(group) => group.kind}>
                {(group) => (
                  <div class="chat-workspace-mobile__group">
                    <Show when={!folder()}>
                      <button
                        type="button"
                        class="chat-workspace-mobile__group-heading"
                        aria-expanded={group().expanded ? "true" : "false"}
                        onClick={() => props.workspace.onToggleMobileGroup?.(group().kind)}
                      >
                        <Icon name={group().expanded ? "chevronDown" : "chevronRight"} />
                        {t(GROUP_LABELS[group().kind])}
                        <span class="chat-workspace-mobile__group-count">
                          {groupCount(group())}
                        </span>
                      </button>
                    </Show>
                    <Show when={folder() || group().expanded}>
                      <MobileGroupRows
                        group={group()}
                        folder={folder()}
                        search={query()}
                        onBrowsePath={onBrowsePath}
                        onBrowseFiles={() => {
                          props.workspace.onSearchOpenChange?.(false);
                          searchField?.focus({ preventScroll: true });
                        }}
                        onOpenFileInsideFiles={(file, origin) =>
                          props.workspace.onOpenFile(file, origin)
                        }
                        onOpenArtifactInsideFiles={(id) => props.workspace.onOpenArtifact(id)}
                      />
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={!path() && selectedFilter() === "all" && attachments()}>
              {(source) => (
                <WorkspaceTranscriptAttachments
                  source={source()}
                  query={query()}
                  presentation="mobile"
                />
              )}
            </Show>
          </div>
        </div>
      </section>
    );
  }

  return (
    <Errored
      fallback={(error, reset) => (
        <View
          status={{
            kind: "error",
            message: formatUiError(error()),
            onRetry: () => {
              onRetry();
              reset();
            },
          }}
        />
      )}
    >
      <Loading on={scope()} fallback={<View status={{ kind: "loading" }} />}>
        {read()}
        <View
          status={
            isPending(read)
              ? model().status.kind === "ready"
                ? { kind: "ready", refreshing: true }
                : { kind: "loading" }
              : model().status
          }
        />
      </Loading>
    </Errored>
  );
}
