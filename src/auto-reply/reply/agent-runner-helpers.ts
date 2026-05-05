import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

const VERBOSE_GATE_SESSION_REFRESH_MS = 250;

function readCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const store = loadSessionStore(params.storePath);
    const entry = store[params.sessionKey];
    return typeof entry?.verboseLevel === "string"
      ? normalizeVerboseLevel(entry.verboseLevel)
      : undefined;
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createCurrentVerboseLevelResolver(
  params: VerboseGateParams,
): () => VerboseLevel | undefined {
  let cachedLevel: VerboseLevel | undefined;
  let cachedAtMs = Number.NEGATIVE_INFINITY;
  return () => {
    if (!params.sessionKey || !params.storePath) {
      return undefined;
    }
    const now = Date.now();
    if (now - cachedAtMs < VERBOSE_GATE_SESSION_REFRESH_MS) {
      return cachedLevel;
    }
    cachedLevel = readCurrentVerboseLevel(params);
    cachedAtMs = now;
    return cachedLevel;
  };
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = params.resolvedVerboseLevel;
  const resolveCurrentVerboseLevel = createCurrentVerboseLevelResolver(params);
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel() ?? fallbackVerbose);
  };
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

export type RunActivityKind =
  | "run-start"
  | "message-start"
  | "text-delta"
  | "reasoning-delta"
  | "visible-tool"
  | "tool-result"
  | "final-payload"
  | "followup-delivery"
  | "background-internal"
  | "subagent-internal"
  | "yield-wait";

export type RunActivityTypingParams = {
  kind?: RunActivityKind;
  toolName?: string;
  channel?: string;
  hasVisibleDeliveryRoute?: boolean;
};

function normalizeActivityText(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function classifyToolRunActivity(params: { toolName?: string }): RunActivityKind {
  const toolName = normalizeActivityText(params.toolName);
  if (toolName === "sessions_yield") {
    return "yield-wait";
  }
  if (toolName === "sessions_spawn" || toolName === "subagents") {
    return "subagent-internal";
  }
  if (toolName === "exec" || toolName === "process") {
    return "background-internal";
  }
  return "visible-tool";
}

export function shouldSignalTypingForRunActivity(params: RunActivityTypingParams = {}): boolean {
  const channel = normalizeActivityText(params.channel);
  if (channel !== "telegram") {
    return true;
  }
  const kind = params.kind ?? classifyToolRunActivity({ toolName: params.toolName });
  if (kind === "background-internal" || kind === "subagent-internal" || kind === "yield-wait") {
    return false;
  }
  if (kind === "tool-result") {
    return classifyToolRunActivity({ toolName: params.toolName }) === "visible-tool";
  }
  if (kind === "followup-delivery") {
    return params.hasVisibleDeliveryRoute === true;
  }
  return true;
}

export function readToolNameFromReplyPayload(payload: ReplyPayload): string | undefined {
  const record = payload as ReplyPayload & { name?: unknown; toolName?: unknown };
  if (typeof record.toolName === "string" && record.toolName.trim()) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.trim()) {
    return record.name;
  }
  const channelData = payload.channelData;
  if (typeof channelData?.toolName === "string" && channelData.toolName.trim()) {
    return channelData.toolName;
  }
  return undefined;
}

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
  params: RunActivityTypingParams = {},
): Promise<void> => {
  if (!shouldSignalTypingForRunActivity(params)) {
    return;
  }
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};
