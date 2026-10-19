import { createSignal, createMemo, Show } from "solid-js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { WorkspaceTranscriptAttachments } from "./chat-session-workspace-attachments.tsx";
import {
  SessionWorkspaceMobile,
  type SessionWorkspaceMobileGroup,
  type SessionWorkspaceMobileLocation,
  type SessionWorkspaceMobileStatus,
} from "./chat-session-workspace-mobile.tsx";
import type { SessionWorkspaceProps } from "./chat-session-workspace.ts";
import { hasTranscriptAttachments } from "./chat-transcript-attachments.ts";

type File = SessionWorkspaceListResult["files"][number];

/** Mobile keeps native groups; desktop's tree is a different presentation of the same owner. */
type MobileWorkspaceProjection = Pick<
  SessionWorkspaceProps,
  | "transcriptAttachments"
  | "list"
  | "sessionKey"
  | "browserPath"
  | "browserSearch"
  | "filter"
  | "loading"
  | "error"
  | "connected"
  | "mobileNavigation"
  | "onRetry"
> & { cachedBrowser?: SessionWorkspaceListResult["browser"] };

function projectMobileWorkspace(workspace: MobileWorkspaceProjection): {
  groups: SessionWorkspaceMobileGroup[];
  status: SessionWorkspaceMobileStatus;
} {
  const list = workspace.list;
  const query = workspace.browserSearch.trim().toLowerCase();
  const path = workspace.browserPath;
  const listed = list?.browser;
  const browser = query
    ? listed?.search?.trim().toLowerCase() === query
      ? listed
      : undefined
    : listed && !listed.search && listed.path === path
      ? listed
      : workspace.cachedBrowser;
  const matches = (...values: (string | undefined)[]) =>
    !query || values.some((value) => value?.toLowerCase().includes(query));
  const groups: SessionWorkspaceMobileGroup[] = [];
  const expanded = workspace.mobileNavigation?.expandedGroups;
  if (!path) {
    for (const kind of ["changed", "read"] as const) {
      if (workspace.filter !== "all" && workspace.filter !== kind) {
        continue;
      }
      const files = new Map<string, File>();
      for (const file of list?.files ?? []) {
        if (
          file.kind !== (kind === "changed" ? "modified" : "read") ||
          !matches(file.path, file.workspacePath, file.name)
        ) {
          continue;
        }
        const key =
          file.workspacePath === undefined
            ? `file:${file.path}`
            : sessionWorkspaceFileKey(workspace.sessionKey, list?.root, file.workspacePath);
        if (!files.has(key)) {
          files.set(key, file);
        }
      }
      if (files.size) {
        groups.push({
          kind,
          files: [...files.values()],
          expanded: expanded?.[kind] ?? kind === "changed",
        });
      }
    }
    const artifacts = list?.artifacts?.filter((artifact) => matches(artifact.title)) ?? [];
    if (artifacts.length && (workspace.filter === "all" || workspace.filter === "artifacts")) {
      groups.push({ kind: "artifacts", artifacts, expanded: expanded?.artifacts ?? false });
    }
  }
  if (browser && (path || workspace.filter === "all")) {
    // Native search is bounded and global. Restrict real results to this folder;
    // retain its truncation warning instead of claiming a complete subtree search.
    const entries =
      path && query
        ? browser.entries.filter((entry) => entry.path.startsWith(`${path}/`))
        : browser.entries;
    if (entries.length || browser.truncated) {
      groups.push({
        kind: "workspace",
        entries,
        truncated: browser.truncated === true,
        expanded: expanded?.workspace ?? true,
      });
    }
  }
  let status: SessionWorkspaceMobileStatus;
  if (workspace.error) {
    status = { kind: "error", message: workspace.error, onRetry: workspace.onRetry };
  } else if (workspace.connected === false && !list) {
    status = {
      kind: "unavailable",
      message: t("chat.workspaceFiles.mobile.disconnected"),
      onRetry: workspace.onRetry,
    };
  } else if (!list || (!browser && listed && (workspace.loading || query))) {
    status = { kind: "loading" };
  } else if (
    groups.length ||
    (!path &&
      workspace.filter === "all" &&
      hasTranscriptAttachments(workspace.transcriptAttachments, query))
  ) {
    status = { kind: "ready", refreshing: workspace.loading };
  } else if (workspace.loading) {
    status = { kind: "loading" };
  } else if (!browser && (path || workspace.filter === "all")) {
    status = {
      kind: "unavailable",
      message: t(
        path ? "chat.workspaceFiles.folderUnavailable" : "chat.workspaceFiles.mobile.unavailable",
      ),
      onRetry: workspace.onRetry,
    };
  } else {
    status = {
      kind: "empty",
      heading: t("chat.sidePanel.files"),
      description: t(
        query ? "chat.workspaceFiles.noSearchResults" : "chat.workspaceFiles.mobile.empty",
      ),
    };
  }
  return { groups, status };
}

export function MobileWorkspaceContents(props: { workspace: SessionWorkspaceProps }) {
  const sessionKey = createMemo(() => props.workspace.sessionKey);
  const attachments = createMemo(() => props.workspace.transcriptAttachments);
  const list = createMemo(() => props.workspace.list);
  const path = createMemo(() => props.workspace.browserPath);
  const query = createMemo(() => props.workspace.browserSearch);
  const filter = createMemo(() => props.workspace.filter);
  const loading = createMemo(() => props.workspace.loading);
  const error = createMemo(() => props.workspace.error);
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
  const model = createMemo(() =>
    projectMobileWorkspace({
      sessionKey: sessionKey(),
      list: list(),
      transcriptAttachments: attachments(),
      browserPath: path(),
      browserSearch: query(),
      filter: filter(),
      loading: loading(),
      error: error(),
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
    }),
  );
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
  const [scroll, onScrollElement] = createSignal<HTMLDivElement | null>(null);
  const destination = createMemo(() => JSON.stringify([sessionKey(), path(), query()]));
  createScrollPosition(() => {
    const element = scroll();
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
  return (
    <SessionWorkspaceMobile
      attachmentContent={
        <Show when={!path() && filter() === "all" && attachments()}>
          {(source) => (
            <WorkspaceTranscriptAttachments
              source={source()}
              query={query()}
              presentation="mobile"
            />
          )}
        </Show>
      }
      groups={model().groups}
      status={model().status}
      location={location()}
      filter={filter()}
      search={query()}
      onSetFilter={(value) => props.workspace.onSetFilter(value)}
      onSearch={(value) => props.workspace.onSearch(value)}
      onBrowsePath={onBrowsePath}
      onOpenFileInsideFiles={(file, origin) => props.workspace.onOpenFile(file, origin)}
      onOpenArtifactInsideFiles={(id) => props.workspace.onOpenArtifact(id)}
      onToggleGroup={(kind) => props.workspace.onToggleMobileGroup?.(kind)}
      onSearchFocus={() => props.workspace.onSearchFocus?.()}
      onScrollElement={onScrollElement}
      onScroll={onScroll}
    />
  );
}
