import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  capArrayByJsonBytes,
  resolveSessionTranscriptCandidates,
} from "../../gateway/session-utils.fs.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  isRequesterSpawnedSessionVisible,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
  outputRefPath: Type.Optional(Type.String()),
  outputRefMaxChars: Type.Optional(Type.Number({ minimum: 256 })),
});

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
const SESSIONS_HISTORY_OUTPUT_REF_MAX_CHARS = 20_000;
const SESSIONS_HISTORY_OUTPUT_REF_MAX_CHARS_HARD_MAX = 120_000;
const SESSIONS_HISTORY_OUTPUT_REF_DIRNAME = "tool-output";

type ToolResultOutputRef = {
  kind: "tool_result_payload";
  path: string;
  bytes?: number;
  sha256?: string;
  contains?: {
    details?: boolean;
    text?: boolean;
  };
};

// sandbox policy handling is shared with sessions-list-tool via sessions-helpers.ts

function truncateHistoryText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  const cut = truncateUtf16Safe(text, SESSIONS_HISTORY_TEXT_MAX_CHARS);
  return { text: `${cut}\n…(truncated)…`, truncated: true };
}

function sanitizeHistoryContentBlock(block: unknown): { block: unknown; truncated: boolean } {
  if (!block || typeof block !== "object") {
    return { block, truncated: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      const res = truncateHistoryText(entry.thinking);
      entry.thinking = res.text;
      truncated ||= res.truncated;
    }
    // The encrypted signature can be extremely large and is not useful for history recall.
    if ("thinkingSignature" in entry) {
      delete entry.thinkingSignature;
      truncated = true;
    }
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
  }
  if (type === "image") {
    const data = typeof entry.data === "string" ? entry.data : undefined;
    const bytes = data ? data.length : undefined;
    if ("data" in entry) {
      delete entry.data;
      truncated = true;
    }
    entry.omitted = true;
    if (bytes !== undefined) {
      entry.bytes = bytes;
    }
  }
  return { block: entry, truncated };
}

function sanitizeHistoryMessage(message: unknown): { message: unknown; truncated: boolean } {
  if (!message || typeof message !== "object") {
    return { message, truncated: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  // Tool result details often contain very large nested payloads.
  if ("details" in entry) {
    const outputRef = readToolResultOutputRef(entry);
    if (outputRef) {
      entry.details = { outputRef };
      truncated = true;
    } else {
      delete entry.details;
      truncated = true;
    }
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
  }
  return { message: entry, truncated };
}

function readToolResultOutputRef(
  message: Record<string, unknown>,
): ToolResultOutputRef | undefined {
  const details = message.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const ref = (details as { outputRef?: unknown }).outputRef;
  if (!ref || typeof ref !== "object") {
    return undefined;
  }
  const rec = ref as Record<string, unknown>;
  const kind = typeof rec.kind === "string" ? rec.kind : "";
  const outputPath = typeof rec.path === "string" ? rec.path.trim() : "";
  if (kind !== "tool_result_payload" || !outputPath) {
    return undefined;
  }
  const containsRaw = rec.contains;
  const contains =
    containsRaw && typeof containsRaw === "object"
      ? {
          details:
            typeof (containsRaw as { details?: unknown }).details === "boolean"
              ? (containsRaw as { details: boolean }).details
              : undefined,
          text:
            typeof (containsRaw as { text?: unknown }).text === "boolean"
              ? (containsRaw as { text: boolean }).text
              : undefined,
        }
      : undefined;
  return {
    kind: "tool_result_payload",
    path: outputPath,
    bytes: typeof rec.bytes === "number" && Number.isFinite(rec.bytes) ? rec.bytes : undefined,
    sha256: typeof rec.sha256 === "string" ? rec.sha256 : undefined,
    contains:
      contains && (contains.details !== undefined || contains.text !== undefined)
        ? contains
        : undefined,
  };
}

function resolveOutputRefPayloadPath(params: {
  transcriptPath: string;
  outputRefPath: string;
}): string | null {
  const sessionDir = path.dirname(params.transcriptPath);
  const baseDir = path.resolve(sessionDir, SESSIONS_HISTORY_OUTPUT_REF_DIRNAME);
  const resolved = path.resolve(sessionDir, params.outputRefPath);
  if (resolved !== baseDir && !resolved.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function resolveOutputRefMaxChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return SESSIONS_HISTORY_OUTPUT_REF_MAX_CHARS;
  }
  const normalized = Math.floor(raw);
  return Math.max(256, Math.min(SESSIONS_HISTORY_OUTPUT_REF_MAX_CHARS_HARD_MAX, normalized));
}

function findOutputRefInMessages(
  messages: unknown[],
  outputRefPath: string,
): ToolResultOutputRef | undefined {
  const needle = outputRefPath.trim();
  if (!needle) {
    return undefined;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const outputRef = readToolResultOutputRef(message as Record<string, unknown>);
    if (outputRef?.path === needle) {
      return outputRef;
    }
  }
  return undefined;
}

async function resolveTranscriptPathForSession(params: {
  resolvedKey: string;
  sessionId?: string;
}): Promise<string | undefined> {
  const listing = await callGateway<{
    path?: string;
    sessions?: Array<{ key?: string; sessionId?: string }>;
  }>({
    method: "sessions.list",
    params: {
      search: params.resolvedKey,
      limit: 8,
      includeGlobal: true,
      includeUnknown: true,
    },
  });

  const sessionId =
    params.sessionId ??
    listing?.sessions?.find((entry) => entry?.key === params.resolvedKey)?.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    return undefined;
  }

  const storePath = typeof listing?.path === "string" ? listing.path : undefined;
  const candidates = resolveSessionTranscriptCandidates(
    sessionId,
    storePath,
    undefined,
    resolveAgentIdFromSessionKey(params.resolvedKey),
  );
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function enforceSessionsHistoryHardCap(params: {
  items: unknown[];
  bytes: number;
  maxBytes: number;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }

  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }

  const placeholder = [
    {
      role: "assistant",
      content: "[sessions_history omitted: message too large]",
    },
  ];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    description: "Fetch message history for a session.",
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const outputRefPathParam = readStringParam(params, "outputRefPath");
      const outputRefMaxChars = resolveOutputRefMaxChars(params.outputRefMaxChars);
      const cfg = loadConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
      if (restrictToSpawned && !resolvedViaSessionId && resolvedKey !== effectiveRequesterKey) {
        const ok = await isRequesterSpawnedSessionVisible({
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
        });
        if (!ok) {
          return jsonResult({
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKeyParam}`,
          });
        }
      }

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const includeTools = Boolean(params.includeTools);
      const result = await callGateway<{ messages: Array<unknown>; sessionId?: string }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];

      let outputRefPayload:
        | {
            path: string;
            bytes: number;
            sha256?: string;
            sha256Verified?: boolean;
            truncated: boolean;
            text: string;
          }
        | undefined;

      if (outputRefPathParam) {
        const outputRef = findOutputRefInMessages(rawMessages, outputRefPathParam);
        if (!outputRef) {
          return jsonResult({
            status: "error",
            error: `Output reference not found in session history: ${outputRefPathParam}`,
            sessionKey: displayKey,
          });
        }
        const transcriptPath = await resolveTranscriptPathForSession({
          resolvedKey,
          sessionId: typeof result?.sessionId === "string" ? result.sessionId : undefined,
        });
        if (!transcriptPath) {
          return jsonResult({
            status: "error",
            error: `Unable to resolve transcript path for session: ${displayKey}`,
            sessionKey: displayKey,
          });
        }
        const payloadPath = resolveOutputRefPayloadPath({
          transcriptPath,
          outputRefPath: outputRef.path,
        });
        if (!payloadPath || !fs.existsSync(payloadPath)) {
          return jsonResult({
            status: "error",
            error: `Output reference file not found: ${outputRef.path}`,
            sessionKey: displayKey,
          });
        }
        const text = fs.readFileSync(payloadPath, "utf-8");
        const truncated = text.length > outputRefMaxChars;
        const textPreview = truncated
          ? `${truncateUtf16Safe(text, outputRefMaxChars)}\n…(truncated)…`
          : text;
        const payloadSha = crypto.createHash("sha256").update(text).digest("hex");
        outputRefPayload = {
          path: outputRef.path,
          bytes: Buffer.byteLength(text, "utf8"),
          sha256: payloadSha,
          sha256Verified:
            typeof outputRef.sha256 === "string" ? outputRef.sha256 === payloadSha : undefined,
          truncated,
          text: textPreview,
        };
      }

      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitizedMessages = selectedMessages.map((message) => sanitizeHistoryMessage(message));
      const contentTruncated = sanitizedMessages.some((entry) => entry.truncated);
      const cappedMessages = capArrayByJsonBytes(
        sanitizedMessages.map((entry) => entry.message),
        SESSIONS_HISTORY_MAX_BYTES,
      );
      const droppedMessages = cappedMessages.items.length < selectedMessages.length;
      const hardened = enforceSessionsHistoryHardCap({
        items: cappedMessages.items,
        bytes: cappedMessages.bytes,
        maxBytes: SESSIONS_HISTORY_MAX_BYTES,
      });
      return jsonResult({
        sessionKey: displayKey,
        messages: hardened.items,
        truncated: droppedMessages || contentTruncated || hardened.hardCapped,
        droppedMessages: droppedMessages || hardened.hardCapped,
        contentTruncated,
        bytes: hardened.bytes,
        outputRefPayload,
      });
    },
  };
}
