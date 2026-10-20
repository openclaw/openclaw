import { formatInlineCodeSpan } from "../../../../../src/shared/markdown-code.js";
import { isHttpArtifactDownloadUrl } from "../../../api/artifact-download.ts";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import type { ArtifactDownloadResult, SessionWorkspaceGetResult } from "../../../api/types.ts";
import { readBlobAsDataUrl } from "../../../lib/blob-data-url.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { isTextAttachment } from "../../../lib/media-file-extension.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import type { FilePreviewSource, SidebarContent } from "./chat-sidebar-content-types.ts";

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

export function unsupportedFileSidebarContent(
  file: SessionWorkspaceGetResult["file"],
  fallbackPath: string,
  download: (signal: AbortSignal) => Promise<SessionFileDownload | null>,
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
    fileDownload: {
      path: filePath,
      name: file.name || pathDisplayName(filePath),
      download,
    },
  };
}

export function readWorkspaceFileText(
  file: SessionWorkspaceGetResult["file"] | undefined,
): string | null {
  return file?.previewKind === "text" &&
    file.contentEncoding === "utf8" &&
    typeof file.content === "string"
    ? file.content
    : null;
}

export function hasUniformLineEndings(content: string): boolean {
  return new Set(content.match(/\r\n?|\n/g)).size <= 1;
}

export async function loadArtifactSidebarContent(
  result: ArtifactDownloadResult & { blob?: Blob },
  download: (signal: AbortSignal) => Promise<Blob | null>,
  resourceBasePath?: string,
): Promise<SidebarContent> {
  const { data, encoding, url, blob } = result;
  const { title } = result.artifact;
  const mimeType = result.artifact.mimeType ?? "";
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
    if (mimeType.startsWith("image/")) {
      // Workspace previews outlive the ticket, so retain the image in the existing data URL form.
      imageSource = await readBlobAsDataUrl(blob, {
        readError: "Artifact image could not be decoded",
        invalidResultError: "Artifact image could not be decoded",
      });
    } else if (isTextAttachment(mimeType, title)) {
      text = await blob.text();
    }
  } else if (encoding === "base64" && data !== undefined) {
    if (mimeType.startsWith("image/")) {
      imageSource = `data:${mimeType};base64,${data}`;
    } else if (isTextAttachment(mimeType, title)) {
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
      mimeType,
      language,
      download: file.download,
    };
  }

  if (blob || encoding === "base64" || (url && isHttpArtifactDownloadUrl(url, resourceBasePath))) {
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

export function readWorkspaceFileText(
  file: SessionWorkspaceGetResult["file"] | undefined,
): string | null {
  return file?.previewKind === "text" &&
    file.contentEncoding === "utf8" &&
    typeof file.content === "string"
    ? file.content
    : null;
}
