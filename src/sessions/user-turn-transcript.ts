import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type PersistedUserTurnMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: string | null;
};

export type PersistedUserTurnMediaFields = {
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }>;

export type BuildPersistedUserTurnMessageParams = {
  text?: string | null;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  timestamp?: number;
  idempotencyKey?: string;
  mediaOnlyText?: string;
};

export type PersistedUserTurnMediaFieldSource = {
  MediaPath?: string | null;
  MediaPaths?: readonly (string | null | undefined)[] | null;
  MediaUrl?: string | null;
  MediaUrls?: readonly (string | null | undefined)[] | null;
  MediaType?: string | null;
  MediaTypes?: readonly (string | null | undefined)[] | null;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTranscriptText(value: string | null | undefined): string {
  return value ?? "";
}

function mediaTypeForTranscript(media: PersistedUserTurnMediaInput): string {
  return (
    normalizeOptionalText(media.contentType) ??
    normalizeOptionalText(media.kind) ??
    "application/octet-stream"
  );
}

function normalizeMediaEntryForTranscript(media: PersistedUserTurnMediaInput):
  | {
      path: string;
      type: string;
    }
  | undefined {
  const path = normalizeOptionalText(media.path) ?? normalizeOptionalText(media.url);
  if (!path) {
    return undefined;
  }
  return {
    path,
    type: mediaTypeForTranscript(media),
  };
}

function normalizeOptionalTextArray(
  values: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  return (
    values?.map(normalizeOptionalText).filter((value): value is string => Boolean(value)) ?? []
  );
}

export function buildPersistedUserTurnMediaInputsFromFields(
  fields: PersistedUserTurnMediaFieldSource | null | undefined,
): PersistedUserTurnMediaInput[] {
  if (!fields) {
    return [];
  }

  const paths = normalizeOptionalTextArray(fields.MediaPaths);
  const urls = normalizeOptionalTextArray(fields.MediaUrls);
  const types = normalizeOptionalTextArray(fields.MediaTypes);
  const singlePath = normalizeOptionalText(fields.MediaPath);
  const singleUrl = normalizeOptionalText(fields.MediaUrl);
  const singleType = normalizeOptionalText(fields.MediaType);
  const mediaCount = Math.max(paths.length, urls.length, singlePath || singleUrl ? 1 : 0);
  const media: PersistedUserTurnMediaInput[] = [];

  for (let index = 0; index < mediaCount; index += 1) {
    const path = paths[index] ?? (index === 0 ? singlePath : undefined);
    const url = urls[index] ?? (index === 0 ? singleUrl : undefined);
    if (!path && !url) {
      continue;
    }
    media.push({
      ...(path ? { path } : {}),
      ...(url ? { url } : {}),
      contentType: types[index] ?? singleType,
    });
  }

  return media;
}

export function buildPersistedUserTurnMediaFields(
  media: readonly PersistedUserTurnMediaInput[] | null | undefined,
): PersistedUserTurnMediaFields {
  const entries = Array.isArray(media) ? media : [];
  const normalized = entries
    .map(normalizeMediaEntryForTranscript)
    .filter((entry): entry is { path: string; type: string } => entry !== undefined);
  const paths = normalized.map((entry) => entry.path);
  if (paths.length === 0) {
    return {};
  }
  const types = normalized.map((entry) => entry.type);
  return {
    MediaPath: paths[0],
    MediaPaths: paths,
    MediaType: types[0],
    MediaTypes: types,
  };
}

export function buildPersistedUserTurnMessage(
  params: BuildPersistedUserTurnMessageParams,
): PersistedUserTurnMessage {
  const mediaFields = buildPersistedUserTurnMediaFields(params.media);
  const hasMedia = Boolean(mediaFields.MediaPath);
  const text = normalizeTranscriptText(params.text);
  const content = text || (hasMedia ? (params.mediaOnlyText ?? "") : "");
  return {
    role: "user",
    content,
    ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...mediaFields,
  } as PersistedUserTurnMessage;
}
