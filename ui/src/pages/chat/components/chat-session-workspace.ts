import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import {
  formatFencedCodeBlock,
  formatInlineCodeSpan,
} from "../../../../../src/shared/markdown-code.js";
import { downloadArtifact, isHttpArtifactDownloadUrl } from "../../../api/artifact-download.ts";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { ArtifactDownloadResult, SessionWorkspaceGetResult } from "../../../api/types.ts";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import { patchSettings, type ChatWorkspaceDock } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { openWorkspaceItem } from "./chat-session-workspace-preview.ts";
import {
  clearWorkspaceTimer,
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
  openSessionCheckoutSidebar,
  refreshSessionWorkspaceState,
  trackSessionCheckoutSidebar,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import { hasUniformLineEndings, type SidebarContent } from "./chat-sidebar.ts";

export {
  clearSessionWorkspaceTimers,
  retireSessionWorkspaceCheckout,
} from "./chat-session-workspace-state.ts";
export { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
export type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
} from "./chat-session-workspace-types.ts";

function languageForFile(name: string): string {
  const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (extension === "yml") {
    return "yaml";
  }
  return extension;
}

function basenameForPath(filePath: string): string {
  return filePath.split(/[\\/]/).findLast((part) => part) ?? filePath;
}

const SESSION_FILE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function formatMarkdownCodeSpan(value: string): string {
  // Markdown finds block boundaries before inline spans, so filenames must
  // stay on one logical line even when the Gateway returns hostile metadata.
  const singleLineValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const hasBoundarySpaces = singleLineValue.startsWith(" ") && singleLineValue.endsWith(" ");
  return formatInlineCodeSpan(
    hasBoundarySpaces && !/^ +$/.test(singleLineValue) ? ` ${singleLineValue} ` : singleLineValue,
  );
}

function formatFileUpdatedAt(updatedAtMs: number | undefined): string | null {
  if (typeof updatedAtMs !== "number") {
    return null;
  }
  const updatedAt = new Date(updatedAtMs);
  return Number.isNaN(updatedAt.getTime()) ? null : updatedAt.toISOString();
}

function unsupportedFileSidebarContent(
  file: SessionWorkspaceGetResult["file"],
  fallbackPath: string,
): SidebarContent {
  const filePath = file.workspacePath || file.path || fallbackPath;
  const updatedAt = formatFileUpdatedAt(file.updatedAtMs);
  const lines = [
    "This file is not previewable inline.",
    "",
    `- Path: ${formatMarkdownCodeSpan(filePath)}`,
    file.mimeType ? `- Type: ${formatMarkdownCodeSpan(file.mimeType)}` : null,
    typeof file.size === "number" ? `- Size: ${file.size.toLocaleString()} bytes` : null,
    updatedAt ? `- Updated: ${updatedAt}` : null,
  ].filter((line): line is string => line !== null);
  const content = lines.join("\n");
  return {
    kind: "markdown",
    content,
    rawText: content,
  };
}

function workspaceBrowserFilePath(root: string | undefined, filePath: string): string {
  if (!root) {
    return filePath;
  }
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const relative = filePath.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  return base ? `${base}${separator}${relative}` : `${separator}${relative}`;
}

async function loadArtifactSidebarContent(
  result: ArtifactDownloadResult & { blob?: Blob },
  download: (signal: AbortSignal) => Promise<Blob | null>,
  resourceBasePath?: string,
): Promise<SidebarContent> {
  const { data, encoding, url, blob } = result;
  const { title } = result.artifact;
  const mimeType = result.artifact.mimeType ?? "";
  let imageSource: string | undefined;
  let text: string | undefined;
  if (blob) {
    if (mimeType.startsWith("image/")) {
      // Workspace previews outlive the ticket, so retain the image in the existing data URL form.
      imageSource = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener(
          "load",
          () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
            } else {
              reject(new Error("Artifact image could not be decoded"));
            }
          },
          { once: true },
        );
        reader.addEventListener(
          "error",
          () => reject(reader.error ?? new Error("Artifact image could not be decoded")),
          { once: true },
        );
        reader.readAsDataURL(blob);
      });
    } else {
      text = await blob.text();
    }
  } else if (encoding === "base64" && data) {
    if (mimeType.startsWith("image/")) {
      imageSource = `data:${mimeType};base64,${data}`;
    } else if (mimeType === "application/json" || mimeType.startsWith("text/")) {
      text = new TextDecoder().decode(
        Uint8Array.from(globalThis.atob(data), (char) => char.charCodeAt(0)),
      );
    }
  }
  if (imageSource) {
    return {
      kind: "image",
      title,
      src: imageSource,
      mimeType,
      rawText: url ?? null,
    };
  }
  if (text !== undefined) {
    const language = mimeType === "application/json" ? "json" : "";
    return {
      kind: "markdown",
      content: `# ${title}\n\n${formatFencedCodeBlock(text, language)}`,
      rawText: text,
    };
  }
  if (encoding === "base64" || (url && isHttpArtifactDownloadUrl(url, resourceBasePath))) {
    return {
      kind: "attachment",
      attachmentKind: "document",
      title,
      mimeType,
      download,
    };
  }
  const content = url
    ? `# ${title}\n\n[Open artifact](${url})`
    : `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}

export function refreshSessionWorkspace(state: SessionWorkspaceHost, refreshFiles: boolean) {
  if (refreshSessionWorkspaceState(state, refreshFiles)) {
    state.sidebarContent = resolveSessionDiffSidebarContent(state);
    state.requestUpdate?.();
  }
}

function openFile(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  opts: { line?: number | null; requestPath?: string } = {},
) {
  const requestPath = opts.requestPath ?? path;
  openWorkspaceItem(
    state,
    workspace,
    `file:${requestPath}`,
    () =>
      state.sessions.getFile(workspace.sessionKey, requestPath, {
        agentId: workspace.agentId,
      }),
    (result) => {
      const file = result.file;
      if (!file) {
        return null;
      }
      const name = file.name || basenameForPath(path);
      if (file.previewKind === "image") {
        if (
          file.contentEncoding !== "base64" ||
          typeof file.content !== "string" ||
          !file.mimeType ||
          !SESSION_FILE_IMAGE_MIME_TYPES.has(file.mimeType)
        ) {
          return null;
        }
        return {
          kind: "image",
          title: name,
          src: `data:${file.mimeType};base64,${file.content}`,
          mimeType: file.mimeType,
          rawText: file.workspacePath || file.path || path,
        };
      }
      if (file.previewKind === "unsupported") {
        return unsupportedFileSidebarContent(file, path);
      }
      // Missing previewKind is the pre-image-preview Gateway contract.
      if (
        (file.previewKind !== undefined && file.previewKind !== "text") ||
        (file.previewKind === "text" &&
          file.contentEncoding !== undefined &&
          file.contentEncoding !== "utf8") ||
        typeof file.content !== "string"
      ) {
        return null;
      }
      const canEdit =
        typeof file.hash === "string" &&
        hasUniformLineEndings(file.content) &&
        isGatewayMethodAdvertised(state, "sessions.files.set") === true &&
        hasOperatorAdminAccess(state.hello?.auth ?? null);
      const edit = canEdit
        ? {
            hash: file.hash!,
            save: async ({ content, expectedHash }: { content: string; expectedHash: string }) => {
              try {
                const saved = await state.sessions.setFile(
                  result.sessionKey,
                  requestPath,
                  content,
                  {
                    agentId: workspace.agentId,
                    expectedHash,
                  },
                );
                const hash = saved?.file.hash;
                const updatedAtMs = saved?.file.updatedAtMs;
                if (typeof hash === "string" && isCurrentSessionWorkspace(state, workspace)) {
                  refreshSessionWorkspace(state, true);
                }
                return typeof hash === "string"
                  ? {
                      ok: true as const,
                      hash,
                      ...(typeof updatedAtMs === "number" ? { updatedAtMs } : {}),
                    }
                  : { ok: false as const, code: "error" as const, message: "Save failed." };
              } catch (error) {
                const details =
                  error instanceof GatewayRequestError &&
                  error.details &&
                  typeof error.details === "object"
                    ? (error.details as { type?: unknown; currentHash?: unknown })
                    : null;
                if (details?.type === "session_file_conflict") {
                  return {
                    ok: false as const,
                    code: "conflict" as const,
                    ...(typeof details.currentHash === "string"
                      ? { currentHash: details.currentHash }
                      : {}),
                  };
                }
                return {
                  ok: false as const,
                  code: "error" as const,
                  message: formatUiError(error),
                };
              }
            },
            fetchLatest: async () => {
              const latest = await state.sessions.getFile(result.sessionKey, requestPath, {
                agentId: workspace.agentId,
              });
              const latestFile = latest?.file;
              if (
                !latestFile ||
                typeof latestFile.content !== "string" ||
                typeof latestFile.hash !== "string"
              ) {
                return null;
              }
              return {
                content: latestFile.content,
                hash: latestFile.hash,
                // Reloaded content re-passes the uniform-endings gate so a
                // conflict reload cannot smuggle mixed endings into edit mode.
                editable: hasUniformLineEndings(latestFile.content),
              };
            },
          }
        : undefined;
      return {
        kind: "file",
        path: file.workspacePath || file.path || path,
        name,
        content: file.content,
        draftKey: [
          state.settings?.gatewayUrl ?? "",
          state.sessionWorkspaceDraftScope ?? "",
          result.sessionKey,
          result.root ?? "",
          file.workspacePath || file.path || path,
        ].join("\u0000"),
        root: result.root ?? null,
        mimeType: file.mimeType,
        language: languageForFile(name),
        line: opts.line ?? null,
        rawText: file.content,
        ...(edit ? { edit } : {}),
      };
    },
    `Failed to load ${path}`,
    {
      line: opts.line,
      label: basenameForPath(path),
      revalidate: true,
      resolveLabel: (result) => result.file?.name,
      resolveKey: (result) => {
        const canonicalPath = result.file?.workspacePath || result.file?.path;
        return canonicalPath ? sessionWorkspaceFileKey(result.root, canonicalPath) : undefined;
      },
    },
  );
}

export function openSessionWorkspaceFile(
  state: SessionWorkspaceHost,
  target: { path: string; line?: number | null },
) {
  openFile(state, getSessionWorkspace(state), target.path, { line: target.line });
}

function toggleSessionWorkspace(state: SessionWorkspaceHost) {
  const workspace = getSessionWorkspace(state);
  workspace.collapsed = !workspace.collapsed;
  if (!workspace.collapsed && workspace.list?.sessionKey !== state.sessionKey) {
    loadSessionWorkspace(state, workspace);
  }
  state.requestUpdate?.();
}

function setSessionWorkspaceDock(state: SessionWorkspaceHost, dock: ChatWorkspaceDock) {
  const workspace = getSessionWorkspace(state);
  if (workspace.dock !== dock) {
    workspace.dock = dock;
    if (state.settings) {
      state.settings = { ...state.settings, chatWorkspaceDock: dock };
    }
    patchSettings({ chatWorkspaceDock: dock });
  }
  state.requestUpdate?.();
}

export function revealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string) {
  const workspace = getSessionWorkspace(state);
  clearWorkspaceTimer(workspace);
  const normalizedPath = path.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  workspace.collapsed = false;
  workspace.browserPath = separator > 0 ? normalizedPath.slice(0, separator) : "";
  workspace.browserSearch = "";
  workspace.filter = "all";
  workspace.activeId = `file:${path}`;
  loadSessionWorkspace(state, workspace, true);
  state.requestUpdate?.();
}

function openArtifact(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  artifactId: string,
) {
  const query = {
    sessionKey: workspace.sessionKey,
    artifactId,
    ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
  };
  const readDownload = async (signal: AbortSignal): Promise<Blob | null> => {
    const currentWorkspace = getSessionWorkspace(state);
    if (
      currentWorkspace.sessionKey !== query.sessionKey ||
      currentWorkspace.agentId !== workspace.agentId
    ) {
      return null;
    }
    // Cached preview actions bind a fresh connection on click; an in-flight
    // transfer must never follow a reconnect to a replacement Gateway.
    const client = state.client;
    const connectionEpoch = state.connectionEpoch;
    const result = await downloadArtifact(state, query, signal, { readBinary: true });
    if (
      signal.aborted ||
      !state.connected ||
      state.client !== client ||
      state.connectionEpoch !== connectionEpoch ||
      !isCurrentSessionWorkspace(state, currentWorkspace)
    ) {
      return null;
    }
    if (result?.blob) {
      return result.blob;
    }
    if (result?.encoding !== "base64" || result.data === undefined) {
      return null;
    }
    return new Blob([Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0))], {
      type: result.artifact.mimeType ?? "application/octet-stream",
    });
  };
  openWorkspaceItem(
    state,
    workspace,
    `artifact:${artifactId}`,
    async () => {
      const result = await downloadArtifact(state, query);
      return result?.artifact
        ? {
            artifact: result.artifact,
            content: await loadArtifactSidebarContent(result, readDownload, state.resourceBasePath),
          }
        : null;
    },
    (result) => result.content,
    `Failed to load artifact ${artifactId}`,
    {
      label:
        workspace.list?.artifacts?.find((artifact) => artifact.id === artifactId)?.title ||
        t("chat.workspaceFiles.artifacts"),
      resolveLabel: (result) => result.artifact?.title,
    },
  );
}

export function createSessionWorkspaceProps(
  state: SessionWorkspaceHost,
  options?: {
    narrowLayout?: boolean;
    draftScope?: string;
    expanded?: boolean;
    presented?: boolean;
  },
): SessionWorkspaceProps {
  state.sessionWorkspaceDraftScope = options?.draftScope;
  const workspace = getSessionWorkspace(state);
  if (
    (options?.expanded === false || options?.presented === false) &&
    workspace.browserSearchTimer
  ) {
    clearWorkspaceTimer(workspace);
    workspace.pendingReload = true;
  }
  if (
    options?.presented !== false &&
    options?.expanded === true &&
    state.connected &&
    state.agentsList &&
    !workspace.loading &&
    !workspace.browserSearchTimer &&
    (!workspace.error || workspace.pendingReload) &&
    (workspace.pendingReload || workspace.list?.sessionKey !== state.sessionKey)
  ) {
    loadSessionWorkspace(state, workspace);
  }
  const diffContent = resolveSessionDiffSidebarContent(state);
  return {
    collapsed: options?.expanded === true ? false : workspace.collapsed,
    sessionKey: state.sessionKey,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error,
    activeId: workspace.activeId,
    dock: workspace.dock,
    narrowLayout: options?.narrowLayout === true,
    filter: workspace.filter,
    browserPath: workspace.browserPath,
    browserSearch: workspace.browserSearch,
    onSetFilter: (filter) => {
      workspace.filter = filter;
      state.requestUpdate?.();
    },
    onToggleCollapsed: () => toggleSessionWorkspace(state),
    onSetDock: (dock) => setSessionWorkspaceDock(state, dock),
    onRefresh: () => loadSessionWorkspace(state, workspace, true),
    onBrowsePath: (path) => {
      clearWorkspaceTimer(workspace);
      workspace.browserPath = path;
      workspace.browserSearch = "";
      loadSessionWorkspace(state, workspace, true);
    },
    onOpenFile: (path, origin) => {
      // Session paths are cwd-relative; browser rows are workspace-root-relative.
      // Keep the origin explicit so a nested cwd cannot shadow the selected browser file.
      const opts =
        origin === "workspace"
          ? { requestPath: workspaceBrowserFilePath(workspace.list?.root, path) }
          : {};
      openFile(state, workspace, path, opts);
    },
    onSearch: (search) => {
      workspace.browserSearch = search;
      state.requestUpdate?.();
      clearWorkspaceTimer(workspace);
      workspace.browserSearchTimer = globalThis.setTimeout(() => {
        workspace.browserSearchTimer = null;
        loadSessionWorkspace(state, workspace, true);
      }, 160);
    },
    onOpenArtifact: (artifactId) => openArtifact(state, workspace, artifactId),
    onOpenDiff: diffContent ? () => openSessionCheckoutSidebar(state, diffContent) : undefined,
  };
}

export function resolveSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  const canOpenDiff =
    isGatewayMethodAdvertised(state, "sessions.diff") === true && Boolean(state.client);
  if (!canOpenDiff) {
    return null;
  }
  if (workspace.diffContent) {
    return workspace.diffContent;
  }
  const sessionKey = state.sessionKey;
  const client = state.client;
  const agentId = workspace.agentId;
  const canLoadFileText =
    isGatewayMethodAdvertised(state, "sessions.files.get") === true && Boolean(state.client);
  const content: SidebarContent = {
    kind: "session-diff",
    load: async (scope) => {
      if (!client) {
        throw new Error(t("chat.sessionDiff.disconnected"));
      }
      return await client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
      });
    },
    loadFileText: canLoadFileText
      ? async (path) => {
          try {
            const result = await state.sessions.getFile(sessionKey, path, {
              agentId,
            });
            const file = result?.file;
            if (
              !file ||
              (file.previewKind !== undefined && file.previewKind !== "text") ||
              (file.contentEncoding !== undefined && file.contentEncoding !== "utf8") ||
              typeof file.content !== "string"
            ) {
              return null;
            }
            return file.content;
          } catch {
            return null;
          }
        }
      : undefined,
    openFile: (path) => openFile(state, getSessionWorkspace(state), path),
  };
  trackSessionCheckoutSidebar(content);
  workspace.diffContent = content;
  return content;
}
