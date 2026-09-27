import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString as asNonEmptyString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ArtifactSummary } from "../../../packages/gateway-protocol/src/index.js";
import {
  type ArtifactBase64Payload,
  base64FromDataUrl,
  mimeFromDataUrl,
  readArtifactBase64Payload,
} from "./artifacts-base64.js";

export type ArtifactRecord = ArtifactSummary & { data?: string; url?: string };

export type ArtifactLookup = {
  artifact?: ArtifactRecord;
  sessionKey?: string;
  assertCurrent?: () => void;
};

export function toArtifactSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _data, url: _url, ...summary } = artifact;
  return summary;
}

export function mediaUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asNonEmptyString(value);
  }
  const record = asOptionalRecord(value);
  return asNonEmptyString(record?.url);
}

function isSafeDownloadUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^data:/i.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return !trimmed.startsWith("//") && trimmed.startsWith("/api/");
  }
  return isHttpUrl(trimmed);
}

export function resolveMessageRunId(message: Record<string, unknown>): string | undefined {
  const meta = asOptionalRecord(message["__openclaw"]);
  return asNonEmptyString(meta?.runId) ?? asNonEmptyString(message.runId);
}

export function resolveBlockDownload(
  block: Record<string, unknown>,
  opts: { includeData: boolean },
): {
  mode: ArtifactSummary["download"]["mode"];
  data?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
} {
  const data = readStringValue(block.data)?.trim();
  const content = readStringValue(block.content)?.trim();
  const url = asNonEmptyString(block.url) ?? asNonEmptyString(block.openUrl);
  const imageUrl = mediaUrlValue(block.image_url);
  const audioUrl = asNonEmptyString(block.audio_url);
  const source = asOptionalRecord(block.source);
  const sourceData = readStringValue(source?.data)?.trim();
  const sourceUrl = asNonEmptyString(source?.url);
  const dataUrl = [url, sourceUrl, imageUrl, audioUrl, data, content, sourceData].find(
    (value) => typeof value === "string" && /^data:/i.test(value),
  );
  const base64FromDetectedDataUrl = readArtifactBase64Payload(
    dataUrl ? base64FromDataUrl(dataUrl) : undefined,
    opts,
  );
  const directBase64 = [data, sourceData, content]
    .filter((value): value is string => typeof value === "string" && !/^data:/i.test(value))
    .map((value) => readArtifactBase64Payload(value, opts))
    .find((value): value is ArtifactBase64Payload => value !== undefined);
  const base64 = base64FromDetectedDataUrl ?? directBase64;
  const remoteUrl = [url, sourceUrl, imageUrl, audioUrl].find(
    (value) => typeof value === "string" && isSafeDownloadUrl(value),
  );
  const mimeType =
    asNonEmptyString(block.mimeType) ??
    asNonEmptyString(block.media_type) ??
    asNonEmptyString(source?.media_type) ??
    asNonEmptyString(source?.mimeType) ??
    (dataUrl ? mimeFromDataUrl(dataUrl) : undefined);
  const explicitSize = block.sizeBytes ?? source?.sizeBytes;
  const sizeBytes =
    typeof explicitSize === "number" && Number.isFinite(explicitSize) && explicitSize >= 0
      ? Math.floor(explicitSize)
      : base64?.sizeBytes;
  if (base64) {
    return { mode: "bytes", data: base64.data, mimeType, sizeBytes };
  }
  if (remoteUrl) {
    return { mode: "url", url: remoteUrl, mimeType, sizeBytes };
  }
  return { mode: "unsupported", mimeType, sizeBytes };
}
