import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { mimeTypeFromFilePath } from "../media/mime.js";
import { emitSessionTranscriptUpdate } from "./transcript-events.js";

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

export type UserTurnInput = {
  text?: string | null;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  timestamp?: number;
  idempotencyKey?: string;
  mediaOnlyText?: string;
};

export type BuildPersistedUserTurnMessageParams = UserTurnInput;

export type UserTurnTranscriptUpdateMode = "inline" | "file-only" | "none";

export type AppendUserTurnTranscriptMessageParams = {
  transcriptPath: string;
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: OpenClawConfig;
  updateMode?: UserTurnTranscriptUpdateMode;
};

export type AppendInlineUserTurnTranscriptMessageParams = Omit<
  AppendUserTurnTranscriptMessageParams,
  "updateMode"
>;

export type PersistUserTurnTranscriptParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
  cwd?: string;
  config?: OpenClawConfig;
  updateMode?: UserTurnTranscriptUpdateMode;
};

export type UserTurnTranscriptPersistenceTarget = Omit<
  PersistUserTurnTranscriptParams,
  "input" | "message" | "updateMode"
>;

type InlineUserTurnTranscriptSource =
  | {
      message: PersistedUserTurnMessage;
      input?: UserTurnInput;
      text?: string | null;
      timestamp?: number;
    }
  | {
      message?: undefined;
      input: UserTurnInput;
      text?: string | null;
      timestamp?: number;
    }
  | {
      message?: undefined;
      input?: undefined;
      text: string;
      timestamp?: number;
    };

export type PersistInlineUserTurnTranscriptParams = UserTurnTranscriptPersistenceTarget &
  InlineUserTurnTranscriptSource;

export type TryPersistInlineUserTurnTranscriptParams = PersistInlineUserTurnTranscriptParams & {
  errorContext?: string;
};

export type PersistedUserTurnTextFieldSource = {
  Transcript?: string | null;
  RawBody?: string | null;
  CommandBody?: string | null;
  BodyForCommands?: string | null;
  Body?: string | null;
  BodyStripped?: string | null;
};

export type ResolvePersistedUserTurnTextOptions = {
  hasMedia?: boolean;
  fallback?: string | null;
};

export type PersistedUserTurnMediaFieldSource = {
  MediaPath?: string | null;
  MediaPaths?: readonly (string | null | undefined)[] | null;
  MediaUrl?: string | null;
  MediaUrls?: readonly (string | null | undefined)[] | null;
  MediaType?: string | null;
  MediaTypes?: readonly (string | null | undefined)[] | null;
  MediaWorkspaceDir?: string | null;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTranscriptText(value: string | null | undefined): string {
  return value ?? "";
}

const MEDIA_PLACEHOLDER_PATTERN = /^<media:[a-z0-9_-]+>(?:\s+\([^)]*\))?$/i;

function normalizePersistedUserTextCandidate(
  value: string | null | undefined,
  options: { hasMedia: boolean },
): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return undefined;
  }
  if (options.hasMedia && MEDIA_PLACEHOLDER_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function resolvePersistedUserTurnText(
  fields: PersistedUserTurnTextFieldSource | null | undefined,
  options: ResolvePersistedUserTurnTextOptions = {},
): string | undefined {
  const hasMedia = options.hasMedia === true;
  const candidates = [
    fields?.Transcript,
    fields?.RawBody,
    fields?.CommandBody,
    fields?.BodyForCommands,
    fields?.Body,
    fields?.BodyStripped,
    options.fallback,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePersistedUserTextCandidate(candidate, { hasMedia });
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
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

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function resolveTranscriptMediaPath(pathValue: string, workspaceDir: string | undefined): string {
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

function resolveTranscriptMediaType(params: {
  explicitType: string | undefined;
  mediaPath: string | undefined;
  mediaUrl: string | undefined;
}): string | undefined {
  return params.explicitType ?? mimeTypeFromFilePath(params.mediaPath ?? params.mediaUrl);
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
  const workspaceDir = normalizeOptionalText(fields.MediaWorkspaceDir);
  const mediaCount = Math.max(paths.length, urls.length, singlePath || singleUrl ? 1 : 0);
  const media: PersistedUserTurnMediaInput[] = [];

  for (let index = 0; index < mediaCount; index += 1) {
    const rawPath = paths[index] ?? (index === 0 ? singlePath : undefined);
    const mediaPath = rawPath ? resolveTranscriptMediaPath(rawPath, workspaceDir) : undefined;
    const url = urls[index] ?? (index === 0 ? singleUrl : undefined);
    if (!mediaPath && !url) {
      continue;
    }
    media.push({
      ...(mediaPath ? { path: mediaPath } : {}),
      ...(url ? { url } : {}),
      contentType: resolveTranscriptMediaType({
        explicitType: types[index] ?? (index === 0 ? singleType : undefined),
        mediaPath,
        mediaUrl: url,
      }),
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

function resolvePersistedUserTurnMessage(
  params: Pick<AppendUserTurnTranscriptMessageParams, "input" | "message">,
): PersistedUserTurnMessage | undefined {
  if (params.message) {
    return params.message;
  }
  if (!params.input) {
    return undefined;
  }
  return buildPersistedUserTurnMessage(params.input);
}

function applyBeforeMessageWriteToUserTurn(
  message: PersistedUserTurnMessage,
  params: Pick<AppendUserTurnTranscriptMessageParams, "agentId" | "sessionKey">,
): PersistedUserTurnMessage | undefined {
  const originalMessage = message as unknown as { idempotencyKey?: unknown };
  const idempotencyKey =
    typeof originalMessage.idempotencyKey === "string" ? originalMessage.idempotencyKey : undefined;
  const nextMessage = runAgentHarnessBeforeMessageWriteHook({
    message,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (nextMessage?.role !== "user") {
    return undefined;
  }
  return idempotencyKey
    ? ({
        ...(nextMessage as unknown as Record<string, unknown>),
        idempotencyKey,
      } as unknown as PersistedUserTurnMessage)
    : nextMessage;
}

export async function appendUserTurnTranscriptMessage(
  params: AppendUserTurnTranscriptMessageParams,
): Promise<
  | {
      sessionFile: string;
      messageId: string;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const resolvedMessage = resolvePersistedUserTurnMessage(params);
  const message = resolvedMessage
    ? applyBeforeMessageWriteToUserTurn(resolvedMessage, params)
    : undefined;
  if (!message) {
    return undefined;
  }

  const appended = await appendSessionTranscriptMessage({
    transcriptPath: params.transcriptPath,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.config ? { config: params.config } : {}),
    message,
    idempotencyLookup: "scan",
  });

  switch (params.updateMode ?? "inline") {
    case "inline":
      if (appended.appended) {
        emitSessionTranscriptUpdate({
          sessionFile: params.transcriptPath,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          message: appended.message,
          messageId: appended.messageId,
        });
      }
      break;
    case "file-only":
      if (appended.appended) {
        emitSessionTranscriptUpdate({
          sessionFile: params.transcriptPath,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        });
      }
      break;
    case "none":
      break;
  }

  return {
    sessionFile: params.transcriptPath,
    messageId: appended.messageId,
    message: appended.message,
  };
}

export async function appendInlineUserTurnTranscriptMessage(
  params: AppendInlineUserTurnTranscriptMessageParams,
): ReturnType<typeof appendUserTurnTranscriptMessage> {
  return await appendUserTurnTranscriptMessage({
    ...params,
    updateMode: "inline",
  });
}

export async function persistUserTurnTranscript(params: PersistUserTurnTranscriptParams): Promise<
  | {
      sessionFile: string;
      sessionEntry: SessionEntry | undefined;
      messageId: string;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    agentId: params.agentId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  });

  const appended = await appendUserTurnTranscriptMessage({
    transcriptPath: sessionFile,
    message,
    sessionId: params.sessionId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.updateMode ? { updateMode: params.updateMode } : {}),
  });
  if (!appended) {
    return undefined;
  }

  return {
    ...appended,
    sessionEntry,
  };
}

export async function persistInlineUserTurnTranscript(
  params: PersistInlineUserTurnTranscriptParams,
): ReturnType<typeof persistUserTurnTranscript> {
  const target: UserTurnTranscriptPersistenceTarget = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    agentId: params.agentId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
  const userTurn = params.message
    ? { message: params.message }
    : params.input
      ? { input: params.input }
      : {
          input: {
            text: params.text,
            timestamp: params.timestamp ?? Date.now(),
          },
        };

  return await persistUserTurnTranscript({
    ...target,
    ...userTurn,
    updateMode: "inline",
  });
}

export async function tryPersistInlineUserTurnTranscript(
  params: TryPersistInlineUserTurnTranscriptParams,
): ReturnType<typeof persistUserTurnTranscript> {
  try {
    return await persistInlineUserTurnTranscript(params);
  } catch (error) {
    logVerbose(
      `failed to persist ${params.errorContext ?? "user turn transcript"}: ${String(error)}`,
    );
    return undefined;
  }
}
