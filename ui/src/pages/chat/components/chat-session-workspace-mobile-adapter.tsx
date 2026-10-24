import { createSignal, createMemo, Errored, isPending, Loading, Show } from "solid-js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { WorkspaceTranscriptAttachments } from "./chat-session-workspace-attachments.tsx";
import {
  SessionWorkspaceMobile,
  type SessionWorkspaceMobileGroup,
  type SessionWorkspaceMobileLocation,
  type SessionWorkspaceMobileProps,
  type SessionWorkspaceMobileStatus,
} from "./chat-session-workspace-mobile.tsx";
import { createSessionWorkspaceRead } from "./chat-session-workspace-read.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import { hasTranscriptAttachments } from "./chat-transcript-attachments.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type File = SessionWorkspaceListResult["files"][number];

export function MobileWorkspaceContents(props: {
  workspace: SessionWorkspaceProps & Pick<SessionWorkspaceMobileProps, "onScrollPortRef">;
}) {
  const { read, scope } = createSessionWorkspaceRead(() => props.workspace);
  const sessionKey = createMemo(() => props.workspace.sessionKey);
  const attachments = createMemo(() => props.workspace.transcriptAttachments);
  const list = createMemo(() => props.workspace.list);
  const path = createMemo(() => props.workspace.browserPath);
  const query = createMemo(() => props.workspace.browserSearch);
  const filter = createMemo(() => props.workspace.filter);
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
      filter: filter(),
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
    const searchQuery = workspace.browserSearch.trim().toLowerCase();
    const browserPath = workspace.browserPath;
    const listed = workspaceList?.browser;
    const browser = searchQuery
      ? listed?.search?.trim().toLowerCase() === searchQuery
        ? listed
        : undefined
      : listed && !listed.search && listed.path === browserPath
        ? listed
        : workspace.cachedBrowser;
    const matches = (...values: (string | undefined)[]) =>
      !searchQuery || values.some((value) => value?.toLowerCase().includes(searchQuery));
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
  const View = (view: { status: SessionWorkspaceMobileStatus }) => (
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
      status={view.status}
      location={location()}
      filter={filter()}
      search={query()}
      onSetFilter={(value) => props.workspace.onSetFilter(value)}
      onSearch={(value) => props.workspace.onSearch(value)}
      onBrowsePath={onBrowsePath}
      onOpenFileInsideFiles={(file, origin) => props.workspace.onOpenFile(file, origin)}
      onOpenArtifactInsideFiles={(id) => props.workspace.onOpenArtifact(id)}
      onToggleGroup={(kind) => props.workspace.onToggleMobileGroup?.(kind)}
      onScrollElement={onScrollElement}
      onScrollPortRef={props.workspace.onScrollPortRef}
      onScroll={onScroll}
    />
  );
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
