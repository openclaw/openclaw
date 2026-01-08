import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";

export type MSTeamsAttachmentLike = {
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

type DownloadCandidate = {
  url: string;
  fileHint?: string;
  contentTypeHint?: string;
  placeholder: string;
};

export type MSTeamsInboundMedia = {
  path: string;
  contentType?: string;
  placeholder: string;
};

const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function inferPlaceholder(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): string {
  const mime = params.contentType?.toLowerCase() ?? "";
  const name = params.fileName?.toLowerCase() ?? "";
  const fileType = params.fileType?.toLowerCase() ?? "";

  const looksLikeImage =
    mime.startsWith("image/") ||
    IMAGE_EXT_RE.test(name) ||
    IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "<media:image>" : "<media:document>";
}

function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) return true;
  if (IMAGE_EXT_RE.test(name)) return true;

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType =
      typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) return true;
    const fileName =
      typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) return true;
  }

  return false;
}

export function buildMSTeamsAttachmentPlaceholder(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return "";
  const imageCount = list.filter(isLikelyImageAttachment).length;
  if (imageCount > 0) {
    return `<media:image>${imageCount > 1 ? ` (${imageCount} images)` : ""}`;
  }
  const count = list.length;
  return `<media:document>${count > 1 ? ` (${count} files)` : ""}`;
}

function resolveDownloadCandidate(
  att: MSTeamsAttachmentLike,
): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = typeof att.name === "string" ? att.name.trim() : "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) return null;
    const downloadUrl =
      typeof att.content.downloadUrl === "string"
        ? att.content.downloadUrl.trim()
        : "";
    if (!downloadUrl) return null;

    const fileType =
      typeof att.content.fileType === "string"
        ? att.content.fileType.trim()
        : "";
    const uniqueId =
      typeof att.content.uniqueId === "string"
        ? att.content.uniqueId.trim()
        : "";
    const fileName =
      typeof att.content.fileName === "string"
        ? att.content.fileName.trim()
        : "";

    const fileHint =
      name ||
      fileName ||
      (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      placeholder: inferPlaceholder({
        contentType,
        fileName: fileHint,
        fileType,
      }),
    };
  }

  const contentUrl =
    typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
  if (!contentUrl) return null;

  return {
    url: contentUrl,
    fileHint: name || undefined,
    contentTypeHint: contentType,
    placeholder: inferPlaceholder({ contentType, fileName: name }),
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const looksLikeGraph =
      host.endsWith("graph.microsoft.com") ||
      host.endsWith("sharepoint.com") ||
      host.endsWith("1drv.ms") ||
      host.includes("sharepoint");
    return looksLikeGraph
      ? [
          "https://graph.microsoft.com/.default",
          "https://api.botframework.com/.default",
        ]
      : [
          "https://api.botframework.com/.default",
          "https://graph.microsoft.com/.default",
        ];
  } catch {
    return [
      "https://api.botframework.com/.default",
      "https://graph.microsoft.com/.default",
    ];
  }
}

async function fetchWithAuthFallback(params: {
  url: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<Response> {
  const fetchFn = params.fetchFn ?? fetch;
  const firstAttempt = await fetchFn(params.url);
  if (firstAttempt.ok) return firstAttempt;
  if (!params.tokenProvider) return firstAttempt;
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403)
    return firstAttempt;

  const scopes = scopeCandidatesForUrl(params.url);
  for (const scope of scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const res = await fetchFn(params.url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return res;
    } catch {
      // Try the next scope.
    }
  }

  return firstAttempt;
}

export async function downloadMSTeamsImageAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) return [];

  const candidates = list
    .filter(isLikelyImageAttachment)
    .map(resolveDownloadCandidate)
    .filter(Boolean) as DownloadCandidate[];

  if (candidates.length === 0) return [];

  const out: MSTeamsInboundMedia[] = [];
  for (const candidate of candidates) {
    try {
      const res = await fetchWithAuthFallback({
        url: candidate.url,
        tokenProvider: params.tokenProvider,
        fetchFn: params.fetchFn,
      });
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > params.maxBytes) continue;
      const mime = await detectMime({
        buffer,
        headerMime:
          candidate.contentTypeHint ?? res.headers.get("content-type"),
        filePath: candidate.fileHint ?? candidate.url,
      });
      const saved = await saveMediaBuffer(
        buffer,
        mime,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: candidate.placeholder,
      });
    } catch {
      // Ignore download failures and continue.
    }
  }
  return out;
}

export function buildMSTeamsMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType ?? "");
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaPaths.length > 0 ? mediaTypes : undefined,
  };
}
