import { BROWSER_IMAGE_MIME_TYPES } from "../../../../../src/shared/browser-image-mime-types.js";
import { formatInlineCodeSpan } from "../../../../../src/shared/markdown-code.js";
import { downloadArtifact, isHttpArtifactDownloadUrl } from "../../../api/artifact-download.ts";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import {
  downloadSessionFile,
  type SessionFileDownload,
} from "../../../api/session-file-download.ts";
import type { ArtifactDownloadResult, SessionWorkspaceGetResult } from "../../../api/types.ts";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import { readBlobAsDataUrl } from "../../../lib/blob-data-url.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { isTextAttachment } from "../../../lib/media-file-extension.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { isSessionFileReadMetadata } from "../../../lib/protocol-validators.generated/session-input.js";
import { listen } from "../../../lib/reactive/listener.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { TEXT_ATTACHMENT_PREVIEW_MAX_BYTES } from "./chat-attachment-text-reader.ts";
import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import {
  admitManagedAttachmentGrant,
  prepareManagedAttachmentGrant,
  readAttachmentSource,
  resolveAttachmentSidebarSource,
} from "./chat-message-attachment-source.ts";
import { loadManagedImageBlob } from "./chat-message-image-loading.ts";
import { releaseChatMediaResourceOwner, type AttachmentItem } from "./chat-message-media.ts";
import {
  readWorkspaceFileText,
  workspaceBrowserFilePath,
} from "./chat-session-workspace-file-content.ts";
import {
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type {
  FilePreviewSource,
  FileSidebarContent,
  SidebarContent,
} from "./chat-sidebar-content-types.ts";

export { downloadSessionFile };

type WorkspaceFileOptions = {
  requestPath: string;
  sessionKey: string;
  agentId?: string;
  messageEntryId?: string;
  line?: number | null;
  draftScope?: string;
  draftContext?: SessionWorkspaceHost["sessionWorkspaceDraftContext"];
  gatewayUrl: string;
  relativeTo?: FileSidebarContent;
};

export async function loadSessionWorkspaceFileContent(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  options: WorkspaceFileOptions,
  refreshFiles: () => void,
) {
  const reference = await readSessionFileReference(
    state,
    options.sessionKey,
    options.agentId,
    options.requestPath,
    options.messageEntryId,
  );
  const document = options.relativeTo;
  if (
    document &&
    reference &&
    (reference.result.root !== (document.root ?? undefined) ||
      reference.result.source?.workspaceId !== document.workspaceSource?.workspaceId ||
      reference.result.source?.root !== document.workspaceSource?.root ||
      reference.result.source?.fileRoot !== document.workspaceSource?.fileRoot)
  ) {
    throw new Error(
      "The document's workspace changed. Reopen the document before following its links.",
    );
  }
  return (
    reference && {
      result: reference.result,
      content: createSessionWorkspaceFileContent(
        state,
        workspace,
        reference,
        options,
        refreshFiles,
      ),
    }
  );
}

function createSessionWorkspaceFileContent(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  reference: NonNullable<Awaited<ReturnType<typeof readSessionFileReference>>>,
  options: WorkspaceFileOptions,
  refreshFiles: () => void,
): SidebarContent | null {
  const { sessionKey, agentId, draftScope, draftContext, gatewayUrl } = options;
  const viewingSession = sessionKey === workspace.sessionKey;
  const messageFile = options.messageEntryId ? { messageEntryId: options.messageEntryId } : {};
  const { result, actionPath } = reference;
  const file = result.file;
  if (!file) {
    return null;
  }
  const name = file.name || pathDisplayName(file.path || actionPath);
  const filePath = file.workspacePath || file.path || actionPath;
  const download = (signal: AbortSignal) =>
    downloadSessionFile(
      state,
      { sessionKey: result.sessionKey, agentId, path: actionPath, ...messageFile },
      signal,
    );
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
      file: {
        path: filePath,
        absolutePath: workspaceBrowserFilePath(result.root, filePath),
        root: result.root,
        download,
      },
    };
  }
  if (file.previewKind === "unsupported") {
    const source: FilePreviewSource = {
      path: filePath,
      absolutePath: workspaceBrowserFilePath(result.root, filePath),
      root: result.root,
      download,
    };
    if (file.mimeType === "application/pdf") {
      return {
        kind: "attachment",
        attachmentKind: "document",
        title: name,
        mimeType: file.mimeType,
        sizeBytes: file.size,
        sourceIdentity: JSON.stringify([
          gatewayUrl,
          result.sessionKey,
          messageFile,
          actionPath,
          result.root,
          result.source,
        ]),
        file: source,
      };
    }
    return {
      ...unsupportedFileSidebarContent(file, actionPath, download),
      fileLinkSessionKey: result.sessionKey,
      file: source,
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
            const saved = await state.sessions.setFile(result.sessionKey, actionPath, content, {
              agentId,
              expectedHash,
              ...(result.source ? { expectedSource: result.source } : {}),
            });
            const hash = saved?.file.hash;
            if (
              typeof hash === "string" &&
              viewingSession &&
              isCurrentSessionWorkspace(state, workspace)
            ) {
              refreshFiles();
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
              typeof error.details === "object" &&
              "type" in error.details
                ? error.details
                : null;
            if (
              details?.type === "session_file_source_changed" &&
              viewingSession &&
              isCurrentSessionWorkspace(state, workspace)
            ) {
              // Reopened browser rows must use the current root, without replacing this draft.
              loadSessionWorkspace(state, workspace, true);
            }
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
          const latest = await state.sessions.getFile(result.sessionKey, actionPath, {
            agentId,
            ...messageFile,
          });
          // A hash-conflict recovery still belongs to the file source that was opened.
          if (
            latest?.source?.workspaceId !== result.source?.workspaceId ||
            latest?.source?.root !== result.source?.root ||
            latest?.source?.fileRoot !== result.source?.fileRoot
          ) {
            return null;
          }
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
    absolutePath: workspaceBrowserFilePath(result.root, filePath),
    name,
    content: text,
    download,
    ...(result.source ? { workspaceSource: result.source } : {}),
    sessionFileSource: {
      sessionKey: result.sessionKey,
      agentId,
      path: actionPath,
      ...messageFile,
    },
    draftKey: [
      gatewayUrl,
      draftScope ?? "",
      result.sessionKey,
      result.root ?? "",
      filePath,
      ...(result.source
        ? [result.source.workspaceId, result.source.root ?? "", result.source.fileRoot ?? ""]
        : []),
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
    line: options.line ?? null,
    rawText: text,
    ...(edit ? { edit } : {}),
  };
}

export async function loadSessionWorkspaceArtifactContent(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  artifactId: string,
  previewSignal: AbortSignal,
) {
  const query = {
    sessionKey: workspace.sessionKey,
    artifactId,
    ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
  };
  const read = async (signal: AbortSignal, readBinary = false) => {
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
    const current = () =>
      !signal.aborted &&
      state.connected &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      isCurrentSessionWorkspace(state, currentWorkspace);
    const preparedGrant = prepareManagedAttachmentGrant(
      { sessionKey: query.sessionKey, artifactId: query.artifactId, connectionEpoch },
      signal,
    );
    try {
      const result = await downloadArtifact(state, query, signal, { readBinary });
      if (!current() || !result) {
        return null;
      }
      const url = result.url;
      const mimeType = result.artifact.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !result.blob &&
        url &&
        isManagedOutgoingMediaSource(url) &&
        BROWSER_IMAGE_MIME_TYPES.has(mimeType)
      ) {
        // Reuse the image owner's scoped bytes and cancellation, not an expiring URL in a tab.
        const onMediaChange = () => {};
        const release = () => releaseChatMediaResourceOwner(onMediaChange);
        const stopAbort = listen(signal, "abort", release, { once: true });
        try {
          const blob = await loadManagedImageBlob(
            url,
            {
              sessionKey: query.sessionKey,
              agentId: workspace.agentId,
              connectionEpoch,
              resourceBasePath: state.resourceBasePath,
              onMediaChange,
              resolveArtifactDownload: async () => ({ url, expiresAt: result.expiresAt }),
            },
            result.artifact.id,
          );
          if (blob.type.split(";", 1)[0]?.trim().toLowerCase() !== mimeType) {
            throw new Error("Artifact image returned an unexpected content type");
          }
          return current() ? { ...result, blob } : null;
        } finally {
          stopAbort();
          release();
        }
      }
      if (
        !result.blob &&
        url &&
        isManagedOutgoingMediaSource(url) &&
        (readBinary ||
          ((isTextAttachment(mimeType, result.artifact.title) || mimeType === "image/svg+xml") &&
            result.artifact.sizeBytes !== undefined &&
            result.artifact.sizeBytes <= TEXT_ATTACHMENT_PREVIEW_MAX_BYTES))
      ) {
        // Consume the freshly authorized grant; retained media readers renew through their owner.
        const blob = await readAttachmentSource(
          artifactAttachment(result, url, false),
          { resourceBasePath: state.resourceBasePath },
          signal,
          readBinary ? Infinity : TEXT_ATTACHMENT_PREVIEW_MAX_BYTES,
        );
        return current() && blob ? { ...result, blob } : null;
      }
      if (
        !readBinary &&
        url &&
        isManagedOutgoingMediaSource(url) &&
        !mimeType.startsWith("image/")
      ) {
        admitManagedAttachmentGrant(
          preparedGrant,
          artifactAttachment(result, url, true),
          result.expiresAt,
        );
      }
      return result;
    } finally {
      preparedGrant.release();
    }
  };
  const readDownload = async (signal: AbortSignal): Promise<Blob | null> => {
    const result = await read(signal, true);
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
  const result = await read(previewSignal);
  return result?.artifact
    ? {
        artifact: result.artifact,
        content: await loadArtifactSidebarContent(result, readDownload, state.resourceBasePath),
      }
    : null;
}

async function readSessionFileReference(
  state: SessionWorkspaceHost,
  sessionKey: string,
  agentId: string | undefined,
  path: string,
  messageEntryId?: string,
): Promise<{ result: SessionWorkspaceGetResult; actionPath: string } | null> {
  const options = { agentId, ...(messageEntryId ? { messageEntryId } : {}) };
  const read = async (actionPath: string) => {
    try {
      const result = await state.sessions.getFile(sessionKey, actionPath, options);
      // A preview can resolve an execution-path alias; actions keep its returned file and source.
      return result
        ? {
            result,
            actionPath: result.file?.workspacePath
              ? workspaceBrowserFilePath(result.root, result.file.workspacePath)
              : actionPath,
          }
        : null;
    } catch (error) {
      const details = error instanceof GatewayRequestError ? error.details : null;
      if (
        details &&
        typeof details === "object" &&
        "type" in details &&
        details.type === "session_file_too_large" &&
        "size" in details &&
        typeof details.size === "number"
      ) {
        const metadata = {
          root: "root" in details ? details.root : undefined,
          source: "source" in details ? details.source : undefined,
        };
        const result: SessionWorkspaceGetResult = {
          sessionKey,
          ...(isSessionFileReadMetadata(metadata) ? metadata : {}),
          file: {
            path: actionPath,
            name: pathDisplayName(actionPath),
            size: details.size,
            kind: "read",
            missing: false,
            previewKind: "unsupported",
          },
        };
        return { result, actionPath };
      }
      throw error;
    }
  };
  try {
    return await read(path);
  } catch (error) {
    const details = error instanceof GatewayRequestError ? error.details : null;
    if (
      !details ||
      typeof details !== "object" ||
      !("type" in details) ||
      details.type !== "session_file_not_found" ||
      !/^[^\\/]+$/u.test(path)
    ) {
      throw error;
    }
    const listing = await state.sessions.listFiles(sessionKey, { agentId, path: "", search: path });
    const browser = listing?.browser;
    if (!listing?.root || !browser || browser.truncated) {
      throw error;
    }
    const matches = browser.entries.filter((entry) => entry.kind === "file" && entry.name === path);
    const [match] = matches;
    if (matches.length !== 1 || !match) {
      throw error;
    }
    // Search paths are root-relative, unlike a session's potentially nested cwd.
    return await read(workspaceBrowserFilePath(listing.root, match.path));
  }
}

function formatMarkdownCodeSpan(value: string): string {
  // Markdown finds block boundaries before inline spans, so filenames must
  // stay on one logical line even when the Gateway returns hostile metadata.
  const singleLineValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return formatInlineCodeSpan(singleLineValue);
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
  download: (signal: AbortSignal) => Promise<SessionFileDownload | null>,
): Extract<SidebarContent, { kind: "markdown" }> {
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
    fileDownload: {
      path: filePath,
      name: file.name || pathDisplayName(filePath),
      download,
    },
  };
}

function hasUniformLineEndings(content: string): boolean {
  return new Set(content.match(/\r\n?|\n/g)).size <= 1;
}

async function loadArtifactSidebarContent(
  result: ArtifactDownloadResult & { blob?: Blob },
  download: (signal: AbortSignal) => Promise<Blob | null>,
  resourceBasePath?: string,
): Promise<SidebarContent> {
  const { data, encoding, url, blob } = result;
  const { title } = result.artifact;
  const mimeType = result.artifact.mimeType ?? "";
  const svg = mimeType.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml";
  const file: FilePreviewSource = {
    path: "",
    artifactId: result.artifact.id,
    download: async (signal) => {
      const downloaded = await download(signal);
      return downloaded ? { blob: downloaded, filename: title } : null;
    },
  };
  let imageSource: string | undefined;
  let text: string | undefined;
  if (blob) {
    if (svg || isTextAttachment(mimeType, title)) {
      text = await blob.text();
    } else if (mimeType.startsWith("image/")) {
      // Workspace previews outlive the ticket, so retain the image in the existing data URL form.
      imageSource = await readBlobAsDataUrl(blob, "Artifact image could not be decoded");
    }
  } else if (encoding === "base64" && data !== undefined) {
    if (svg || isTextAttachment(mimeType, title)) {
      text = new TextDecoder().decode(base64ToBytes(data));
    } else if (mimeType.startsWith("image/")) {
      imageSource = `data:${mimeType};base64,${data}`;
    }
  }
  if (imageSource) {
    return {
      kind: "image",
      title,
      src: imageSource,
      mimeType,
      rawText: url ?? null,
      file,
    };
  }
  if (text !== undefined) {
    const language = mimeType === "application/json" ? "json" : "";
    return {
      kind: "file",
      path: "",
      artifactId: result.artifact.id,
      name: title,
      content: text,
      rawText: text,
      mimeType: svg ? "image/svg+xml" : mimeType,
      language,
      download: file.download,
    };
  }

  if (url && isManagedOutgoingMediaSource(url) && !mimeType.startsWith("image/")) {
    const attachment = artifactAttachment(result, url, true);
    return {
      kind: "attachment",
      attachmentKind: attachment.kind,
      title,
      mimeType,
      sizeBytes: result.artifact.sizeBytes,
      sourceIdentity: url,
      resolveSource: (onMediaChange, runtime) =>
        resolveAttachmentSidebarSource(attachment, { ...runtime, onMediaChange }),
      file,
    };
  }

  if (
    blob ||
    encoding === "base64" ||
    (url && (isHttpArtifactDownloadUrl(url, resourceBasePath) || isManagedOutgoingMediaSource(url)))
  ) {
    return {
      kind: "attachment",
      attachmentKind: "document",
      title,
      mimeType,
      download,
      file,
    };
  }
  const content = url
    ? `# ${title}\n\n[Open artifact](${url})`
    : `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}

function artifactAttachment(
  result: ArtifactDownloadResult,
  url: string,
  renewable: boolean,
): AttachmentItem["attachment"] {
  const mimeType = result.artifact.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return {
    kind: mimeType.startsWith("video/")
      ? "video"
      : mimeType.startsWith("audio/")
        ? "audio"
        : "document",
    label: result.artifact.title,
    mimeType,
    sizeBytes: result.artifact.sizeBytes,
    url,
    ...(renewable ? { artifactId: result.artifact.id } : {}),
  };
}
