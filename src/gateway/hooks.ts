import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { type HookMappingResolved, resolveHookMappings } from "./hooks-mapping.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;

export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  agentPolicy: HookAgentPolicyResolved;
  sessionPolicy: HookSessionPolicyResolved;
};

export type HookAgentPolicyResolved = {
  defaultAgentId: string;
  knownAgentIds: Set<string>;
  allowedAgentIds?: Set<string>;
};

export type HookSessionPolicyResolved = {
  defaultSessionKey?: string;
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes?: string[];
};

export function resolveHooksConfig(cfg: OpenClawConfig): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) {
    return null;
  }
  const token = cfg.hooks?.token?.trim();
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") {
    throw new Error("hooks.path may not be '/'");
  }
  const maxBodyBytes =
    cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0
      ? cfg.hooks.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;
  const mappings = resolveHookMappings(cfg.hooks);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const knownAgentIds = resolveKnownAgentIds(cfg, defaultAgentId);
  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const defaultSessionKey = resolveSessionKey(cfg.hooks?.defaultSessionKey);
  const allowedSessionKeyPrefixes = resolveAllowedSessionKeyPrefixes(
    cfg.hooks?.allowedSessionKeyPrefixes,
  );
  if (
    defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix(defaultSessionKey, allowedSessionKeyPrefixes)
  ) {
    throw new Error("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");
  }
  if (
    !defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix("hook:example", allowedSessionKeyPrefixes)
  ) {
    throw new Error(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  }
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    agentPolicy: {
      defaultAgentId,
      knownAgentIds,
      allowedAgentIds,
    },
    sessionPolicy: {
      defaultSessionKey,
      allowRequestSessionKey: cfg.hooks?.allowRequestSessionKey === true,
      allowedSessionKeyPrefixes,
    },
  };
}

function resolveKnownAgentIds(cfg: OpenClawConfig, defaultAgentId: string): Set<string> {
  const known = new Set(listAgentIds(cfg));
  known.add(defaultAgentId);
  return known;
}

function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  let hasWildcard = false;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      hasWildcard = true;
      break;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  if (hasWildcard) {
    return undefined;
  }
  return allowed;
}

function resolveSessionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function normalizeSessionKeyPrefix(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return value ? value : undefined;
}

function resolveAllowedSessionKeyPrefixes(raw: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const set = new Set<string>();
  for (const prefix of raw) {
    const normalized = normalizeSessionKeyPrefix(prefix);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return set.size > 0 ? Array.from(set) : undefined;
}

function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function extractHookToken(req: IncomingMessage): string | undefined {
  const auth =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  const headerToken =
    typeof req.headers["x-openclaw-token"] === "string"
      ? req.headers["x-openclaw-token"].trim()
      : "";
  if (headerToken) {
    return headerToken;
  }
  return undefined;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await readJsonBodyWithLimit(req, { maxBytes, emptyObjectOnEmpty: true });
  if (result.ok) {
    return result;
  }
  if (result.code === "PAYLOAD_TOO_LARGE") {
    return { ok: false, error: "payload too large" };
  }
  if (result.code === "REQUEST_BODY_TIMEOUT") {
    return { ok: false, error: "request body timeout" };
  }
  if (result.code === "CONNECTION_CLOSED") {
    return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
  }
  return { ok: false, error: result.error };
}

export function normalizeHookHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

export function normalizeWakePayload(
  payload: Record<string, unknown>,
):
  | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
  | { ok: false; error: string } {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return { ok: false, error: "text required" };
  }
  const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
  return { ok: true, value: { text, mode } };
}

export type HookAgentPayload = {
  message: string;
  name: string;
  agentId?: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey?: string;
  deliver: boolean;
  channel: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

const listHookChannelValues = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)];

export type HookMessageChannel = ChannelId | "last";

const getHookChannelSet = () => new Set<string>(listHookChannelValues());
export const getHookChannelError = () => `channel must be ${listHookChannelValues().join("|")}`;

export function resolveHookChannel(raw: unknown): HookMessageChannel | null {
  if (raw === undefined) {
    return "last";
  }
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !getHookChannelSet().has(normalized)) {
    return null;
  }
  return normalized as HookMessageChannel;
}

export function resolveHookDeliver(raw: unknown): boolean {
  return raw !== false;
}

export function resolveHookTargetAgentId(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): string | undefined {
  const raw = agentId?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeAgentId(raw);
  if (hooksConfig.agentPolicy.knownAgentIds.has(normalized)) {
    return normalized;
  }
  return hooksConfig.agentPolicy.defaultAgentId;
}

export function isHookAgentAllowed(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): boolean {
  // Keep backwards compatibility for callers that omit agentId.
  const raw = agentId?.trim();
  if (!raw) {
    return true;
  }
  const allowed = hooksConfig.agentPolicy.allowedAgentIds;
  if (allowed === undefined) {
    return true;
  }
  const resolved = resolveHookTargetAgentId(hooksConfig, raw);
  return resolved ? allowed.has(resolved) : false;
}

export const getHookAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
export const getHookSessionKeyRequestPolicyError = () =>
  "sessionKey is disabled for external /hooks/agent payloads; set hooks.allowRequestSessionKey=true to enable";
export const getHookSessionKeyPrefixError = (prefixes: string[]) =>
  `sessionKey must start with one of: ${prefixes.join(", ")}`;

export function resolveHookSessionKey(params: {
  hooksConfig: HooksConfigResolved;
  source: "request" | "mapping";
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const requested = resolveSessionKey(params.sessionKey);
  if (requested) {
    if (params.source === "request" && !params.hooksConfig.sessionPolicy.allowRequestSessionKey) {
      return { ok: false, error: getHookSessionKeyRequestPolicyError() };
    }
    const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
    if (allowedPrefixes && !isSessionKeyAllowedByPrefix(requested, allowedPrefixes)) {
      return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
    }
    return { ok: true, value: requested };
  }

  const defaultSessionKey = params.hooksConfig.sessionPolicy.defaultSessionKey;
  if (defaultSessionKey) {
    return { ok: true, value: defaultSessionKey };
  }

  const generated = `hook:${(params.idFactory ?? randomUUID)()}`;
  const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
  if (allowedPrefixes && !isSessionKeyAllowedByPrefix(generated, allowedPrefixes)) {
    return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
  }
  return { ok: true, value: generated };
}

export function normalizeAgentPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      value: HookAgentPayload;
    }
  | { ok: false; error: string } {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return { ok: false, error: "message required" };
  }
  const nameRaw = payload.name;
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
  const agentIdRaw = payload.agentId;
  const agentId =
    typeof agentIdRaw === "string" && agentIdRaw.trim() ? agentIdRaw.trim() : undefined;
  const wakeMode = payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const sessionKeyRaw = payload.sessionKey;
  const sessionKey =
    typeof sessionKeyRaw === "string" && sessionKeyRaw.trim() ? sessionKeyRaw.trim() : undefined;
  const channel = resolveHookChannel(payload.channel);
  if (!channel) {
    return { ok: false, error: getHookChannelError() };
  }
  const toRaw = payload.to;
  const to = typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : undefined;
  const modelRaw = payload.model;
  const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : undefined;
  if (modelRaw !== undefined && !model) {
    return { ok: false, error: "model required" };
  }
  const deliver = resolveHookDeliver(payload.deliver);
  const thinkingRaw = payload.thinking;
  const thinking =
    typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : undefined;
  const timeoutRaw = payload.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  return {
    ok: true,
    value: {
      message,
      name,
      agentId,
      wakeMode,
      sessionKey,
      deliver,
      channel,
      to,
      model,
      thinking,
      timeoutSeconds,
    },
  };
}
