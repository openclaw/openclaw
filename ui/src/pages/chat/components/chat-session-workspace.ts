import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { BROWSER_IMAGE_MIME_TYPES } from "../../../../../src/shared/browser-image-mime-types.js";
import {
  formatFencedCodeBlock,
  formatInlineCodeSpan,
} from "../../../../../src/shared/markdown-code.js";
import { downloadArtifact, isHttpArtifactDownloadUrl } from "../../../api/artifact-download.ts";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { ArtifactDownloadResult, SessionWorkspaceGetResult } from "../../../api/types.ts";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { readBlobAsDataUrl } from "../../../lib/blob-data-url.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { openWorkspaceItem } from "./chat-session-workspace-preview.ts";
import {
  clearWorkspaceTimer,
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
  refreshSessionWorkspaceState,
  trackSessionCheckoutSidebar,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { hasUniformLineEndings } from "./chat-sidebar-file-view.tsx";

registerFilePreviewEnglish();

export { retireSessionWorkspaceCheckout } from "./chat-session-workspace-state.ts";
export { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
export type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
} from "./chat-session-workspace-types.ts";

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

function readWorkspaceFileText(file: SessionWorkspaceGetResult["file"] | undefined): string | null {
  return file?.previewKind === "text" &&
    file.contentEncoding === "utf8" &&
    typeof file.content === "string"
    ? file.content
    : null;
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
      imageSource = await readBlobAsDataUrl(blob, {
        readError: "Artifact image could not be decoded",
        invalidResultError: "Artifact image could not be decoded",
      });
    } else {
      text = await blob.text();
    }
  } else if (encoding === "base64" && data) {
    if (mimeType.startsWith("image/")) {
      imageSource = `data:${mimeType};base64,${data}`;
    } else if (mimeType === "application/json" || mimeType.startsWith("text/")) {
      text = new TextDecoder().decode(base64ToBytes(data));
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
  opts: { line?: number | null; requestPath?: string; sessionKey?: string } = {},
) {
  const requestPath = opts.requestPath ?? path;
  const sessionKey = opts.sessionKey ?? workspace.sessionKey;
  const agentId = opts.sessionKey
    ? parseAgentSessionKey(opts.sessionKey)?.agentId
    : workspace.agentId;
  const viewingSession = sessionKey === workspace.sessionKey;
  const draftScope = state.sessionWorkspaceDraftScope;
  const draftContext = state.sessionWorkspaceDraftContext;
  const gatewayUrl = state.settings?.gatewayUrl ?? "";
  openWorkspaceItem(
    state,
    workspace,
    viewingSession ? `file:${requestPath}` : JSON.stringify(["file", sessionKey, requestPath]),
    () =>
      state.sessions.getFile(sessionKey, requestPath, {
        agentId,
      }),
    (result) => {
      const file = result.file;
      if (!file) {
        return null;
      }
      const name = file.name || pathDisplayName(path);
      const filePath = file.workspacePath || file.path || path;
      if (file.previewKind === "image") {
        if (
          file.contentEncoding !== "base64" ||
          typeof file.content !== "string" ||
          !file.mimeType ||
          !BROWSER_IMAGE_MIME_TYPES.has(file.mimeType)
        ) {
          return null;
        }
        return {
          kind: "image",
          title: name,
          src: `data:${file.mimeType};base64,${file.content}`,
          mimeType: file.mimeType,
          rawText: filePath,
        };
      }
      if (file.previewKind === "unsupported") {
        return {
          ...unsupportedFileSidebarContent(file, path),
          fileLinkSessionKey: result.sessionKey,
        };
      }
      const text = readWorkspaceFileText(file);
      if (text === null) {
        return null;
      }
      const canEdit =
        typeof file.hash === "string" &&
        hasUniformLineEndings(text) &&
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
                    agentId,
                    expectedHash,
                  },
                );
                const hash = saved?.file.hash;
                if (
                  typeof hash === "string" &&
                  viewingSession &&
                  isCurrentSessionWorkspace(state, workspace)
                ) {
                  refreshSessionWorkspace(state, true);
                }
                return typeof hash === "string"
                  ? {
                      ok: true as const,
                      hash,
                    }
                  : { ok: false as const, code: "error" as const, message: "Save failed." };
              } catch (error) {
                const details =
                  error instanceof GatewayRequestError &&
                  error.details &&
                  typeof error.details === "object"
                    ? (error.details as { type?: unknown })
                    : null;
                if (details?.type === "session_file_conflict") {
                  return {
                    ok: false as const,
                    code: "conflict" as const,
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
                agentId,
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
      const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
      return {
        kind: "file",
        path: filePath,
        name,
        content: text,
        sessionFileSource: {
          sessionKey: result.sessionKey,
          agentId,
          path: filePath,
        },
        draftKey: [
          gatewayUrl,
          draftScope ?? "",
          result.sessionKey,
          result.root ?? "",
          filePath,
        ].join("\u0000"),
        draftContext: {
          sessionKey: result.sessionKey,
          sessionTitle:
            (viewingSession ? draftContext?.sessionTitle : undefined) ??
            resolveSessionDisplayName(result.sessionKey),
          paneLabel: draftContext?.paneLabel,
        },
        root: result.root ?? null,
        mimeType: file.mimeType,
        language: extension === "yml" ? "yaml" : extension,
        line: opts.line ?? null,
        rawText: text,
        ...(edit ? { edit } : {}),
      };
    },
    `Failed to load ${path}`,
    {
      line: opts.line,
      label: pathDisplayName(path),
      revalidate: true,
      resolveLabel: (result) => result.file?.name,
      resolveKey: (result) => {
        const canonicalPath = result.file?.workspacePath || result.file?.path;
        return canonicalPath
          ? sessionWorkspaceFileKey(result.sessionKey, result.root, canonicalPath)
          : undefined;
      },
      resolveError: (error) =>
        error instanceof GatewayRequestError &&
        typeof error.details === "object" &&
        error.details !== null &&
        "reason" in error.details &&
        error.details.reason === "outside_session_boundary"
          ? t("chat.detailPanel.outsideSessionBoundary", {
              session:
                (viewingSession ? draftContext?.sessionTitle : undefined) ??
                resolveSessionDisplayName(sessionKey),
            })
          : undefined,
    },
  );
}

export function openSessionWorkspaceFile(
  state: SessionWorkspaceHost,
  target: MarkdownFileLinkTarget,
) {
  openFile(state, getSessionWorkspace(state), target.path, {
    line: target.line,
    sessionKey: target.sessionKey,
  });
}

export function revealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string) {
  const workspace = getSessionWorkspace(state);
  clearWorkspaceTimer(workspace);
  const normalizedPath = path.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
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
    return new Blob([base64ToBytes(result.data)], {
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
    draftScope?: string;
    draftContext?: SessionWorkspaceHost["sessionWorkspaceDraftContext"];
    expanded?: boolean;
    presented?: boolean;
  },
): SessionWorkspaceProps {
  state.sessionWorkspaceDraftScope = options?.draftScope;
  state.sessionWorkspaceDraftContext = options?.draftContext;
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
    sessionKey: state.sessionKey,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error,
    activeId: workspace.activeId,
    filter: workspace.filter,
    browserPath: workspace.browserPath,
    browserSearch: workspace.browserSearch,
    onSetFilter: (filter) => {
      workspace.filter = filter;
      state.requestUpdate?.();
    },
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
    onOpenDiff: diffContent ? () => state.handleOpenSidebar(diffContent) : undefined,
  };
}

export function resolveSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  const client = state.client;
  if (isGatewayMethodAdvertised(state, "sessions.diff") !== true || !client) {
    return null;
  }
  if (workspace.diffContent) {
    return workspace.diffContent;
  }
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  const canLoadFileText =
    isGatewayMethodAdvertised(state, "sessions.files.get") === true && Boolean(state.client);
  const content: SidebarContent = {
    kind: "session-diff",
    // Checkout retirement replaces this identity; ordinary refreshes retain it.
    owner: workspace,
    load: async (scope) =>
      await client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
      }),
    loadFileText: canLoadFileText
      ? async (path) => {
          try {
            const result = await state.sessions.getFile(sessionKey, path, {
              agentId,
            });
            return readWorkspaceFileText(result?.file);
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
