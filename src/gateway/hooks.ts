// Gateway webhook helpers for external hook dispatch into agents and wake flows.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertSafeCronSessionTargetId } from "../cron/session-target.js";
import type { CronSessionTarget } from "../cron/types.js";
import { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  hasHookTemplateExpressions,
  type HookMappingResolved,
  resolveHookMappings,
} from "./hooks-mapping.js";
import { resolveAllowedAgentIds } from "./hooks-policy.js";
import type { HookMessageChannel } from "./hooks.types.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;
const MAX_HOOK_IDEMPOTENCY_KEY_LENGTH = 256;
const DEFAULT_HOOK_QUEUE_PARALLELISM = 1;
const MAX_HOOK_QUEUE_PARALLELISM = 100;
const HOOK_QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Fully resolved hooks config used by gateway hook request handling. */
export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  queues: HookQueueResolved[];
  agentPolicy: HookAgentPolicyResolved;
  sessionPolicy: HookSessionPolicyResolved;
};

export type HookQueueResolved = {
  id: string;
  path: string;
  parallelism: number;
  sessionTarget: Extract<CronSessionTarget, "isolated" | `session:${string}`>;
  sessionKey?: string;
  name?: string;
  agentId?: string;
  wakeMode?: "now" | "next-heartbeat";
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

type HookAgentPolicyResolved = {
  defaultAgentId: string;
  knownAgentIds: Set<string>;
  allowedAgentIds?: Set<string>;
};

type HookSessionPolicyResolved = {
  defaultSessionKey?: string;
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes?: string[];
};

type HookSessionKeySource = "request" | "mapping-static" | "mapping-templated";

/** Resolve and validate hook config, returning null when hooks are disabled. */
export function resolveHooksConfig(cfg: OpenClawConfig): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) {
    return null;
  }
  const token = normalizeOptionalString(cfg.hooks?.token);
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = normalizeOptionalString(cfg.hooks?.path) || DEFAULT_HOOKS_PATH;
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
  const queues = resolveHookQueues(cfg, trimmed);
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
  if (hasEffectiveTemplatedHookSessionKeyMapping(mappings) && !allowedSessionKeyPrefixes) {
    throw new Error(
      "hooks.allowedSessionKeyPrefixes is required when a hook mapping sessionKey uses templates, even if hooks.allowRequestSessionKey=true",
    );
  }
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    queues,
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

function normalizeHookQueueId(raw: string): string {
  const value = raw.trim();
  if (!HOOK_QUEUE_ID_PATTERN.test(value)) {
    throw new Error(
      "hooks.queues keys must start with a letter or number and contain only letters, numbers, '.', '_', or '-'",
    );
  }
  return value;
}

function resolveHookQueuePath(params: {
  queueId: string;
  basePath: string;
  path?: string;
}): string {
  const rawPath = normalizeOptionalString(params.path) ?? `queue/${params.queueId}`;
  let relativePath = rawPath;
  if (rawPath.startsWith("/")) {
    if (rawPath === params.basePath) {
      throw new Error(`hooks.queues.${params.queueId}.path must not equal hooks.path`);
    }
    if (!rawPath.startsWith(`${params.basePath}/`)) {
      throw new Error(`hooks.queues.${params.queueId}.path must be under hooks.path`);
    }
    relativePath = rawPath.slice(params.basePath.length + 1);
  }
  const normalized = relativePath.replace(/^\/+|\/+$/gu, "");
  if (
    !normalized ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.split("/").some((part) => !part)
  ) {
    throw new Error(`hooks.queues.${params.queueId}.path must be a non-empty URL path`);
  }
  if (normalized === "agent" || normalized === "wake") {
    throw new Error(`hooks.queues.${params.queueId}.path conflicts with a built-in hook path`);
  }
  return normalized;
}

function resolveHookQueueParallelism(raw: number | undefined): number {
  if (!Number.isFinite(raw) || raw === undefined) {
    return DEFAULT_HOOK_QUEUE_PARALLELISM;
  }
  return Math.max(1, Math.min(MAX_HOOK_QUEUE_PARALLELISM, Math.floor(raw)));
}

function resolveHookQueueSessionTarget(
  queueId: string,
  raw: string | undefined,
): Extract<CronSessionTarget, "isolated" | `session:${string}`> {
  const value = normalizeOptionalString(raw);
  if (!value || value === "isolated") {
    return "isolated";
  }
  if (value.startsWith("session:")) {
    return `session:${assertSafeCronSessionTargetId(value.slice("session:".length))}`;
  }
  throw new Error(`hooks.queues.${queueId}.sessionTarget must be "isolated" or "session:<id>"`);
}

function resolveHookQueues(cfg: OpenClawConfig, basePath: string): HookQueueResolved[] {
  const rawQueues = cfg.hooks?.queues;
  if (!rawQueues || typeof rawQueues !== "object" || Array.isArray(rawQueues)) {
    return [];
  }
  const paths = new Set<string>();
  const queues: HookQueueResolved[] = [];
  for (const [rawQueueId, rawQueue] of Object.entries(rawQueues)) {
    if (rawQueue?.enabled === false) {
      continue;
    }
    const id = normalizeHookQueueId(rawQueueId);
    const queuePath = resolveHookQueuePath({ queueId: id, basePath, path: rawQueue?.path });
    if (paths.has(queuePath)) {
      throw new Error(`hooks.queues.${id}.path duplicates another hook queue path`);
    }
    paths.add(queuePath);
    const sessionTarget = resolveHookQueueSessionTarget(id, rawQueue?.sessionTarget);
    const sessionKey = resolveSessionKey(rawQueue?.sessionKey);
    const name = normalizeOptionalString(rawQueue?.name);
    const agentId = normalizeOptionalString(rawQueue?.agentId);
    const channel = normalizeOptionalString(rawQueue?.channel);
    const to = normalizeOptionalString(rawQueue?.to);
    const model = normalizeOptionalString(rawQueue?.model);
    const thinking = normalizeOptionalString(rawQueue?.thinking);
    queues.push({
      id,
      path: queuePath,
      parallelism: resolveHookQueueParallelism(rawQueue?.parallelism),
      sessionTarget,
      ...(sessionKey ? { sessionKey } : {}),
      ...(name ? { name } : {}),
      ...(agentId ? { agentId } : {}),
      wakeMode: rawQueue?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now",
      ...(rawQueue?.deliver !== undefined ? { deliver: rawQueue.deliver } : {}),
      ...(rawQueue?.allowUnsafeExternalContent === true
        ? { allowUnsafeExternalContent: true }
        : {}),
      ...(channel ? { channel } : {}),
      ...(to ? { to } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(typeof rawQueue?.timeoutSeconds === "number" &&
      Number.isFinite(rawQueue.timeoutSeconds) &&
      rawQueue.timeoutSeconds > 0
        ? { timeoutSeconds: Math.floor(rawQueue.timeoutSeconds) }
        : {}),
    });
  }
  return queues.toSorted((left, right) => left.id.localeCompare(right.id));
}

function resolveKnownAgentIds(cfg: OpenClawConfig, defaultAgentId: string): Set<string> {
  const known = new Set(listAgentIds(cfg));
  known.add(defaultAgentId);
  return known;
}

function resolveSessionKey(raw: string | undefined): string | undefined {
  return normalizeOptionalString(raw);
}

function normalizeSessionKeyPrefix(raw: string): string | undefined {
  const value = normalizeLowercaseStringOrEmpty(raw);
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

/** Check whether a hook session key satisfies the configured prefix allowlist. */
export function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalized) {
    return false;
  }
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

/** Extract the hook bearer token from Authorization or x-openclaw-token headers. */
export function extractHookToken(req: IncomingMessage): string | undefined {
  const auth = normalizeOptionalString(req.headers.authorization) ?? "";
  if (normalizeLowercaseStringOrEmpty(auth).startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  const headerToken = normalizeOptionalString(req.headers["x-openclaw-token"]) ?? "";
  if (headerToken) {
    return headerToken;
  }
  return undefined;
}

/** Read and normalize a hook JSON request body with gateway-friendly error text. */
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

/** Normalize request headers into lowercase string values for hook template matching. */
export function normalizeHookHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const normalizedKey = normalizeLowercaseStringOrEmpty(key);
    if (typeof value === "string") {
      headers[normalizedKey] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[normalizedKey] = value.join(", ");
    }
  }
  return headers;
}

/** Validate a hook wake payload. */
export function normalizeWakePayload(
  payload: Record<string, unknown>,
):
  | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
  | { ok: false; error: string } {
  const normalizedText = normalizeOptionalString(payload.text) ?? "";
  if (!normalizedText) {
    return { ok: false, error: "text required" };
  }
  const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
  return { ok: true, value: { text: normalizedText, mode } };
}

type HookAgentPayload = {
  message: string;
  name: string;
  agentId?: string;
  idempotencyKey?: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey?: string;
  deliver: boolean;
  channel: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

/** Normalized agent dispatch payload after hook policy/session resolution. */
export type HookAgentDispatchPayload = Omit<HookAgentPayload, "sessionKey"> & {
  sessionKey: string;
  sourcePath: string;
  allowUnsafeExternalContent?: boolean;
  externalContentSource?: HookExternalContentSource;
};

const listHookChannelValues = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)];

/** Channel values accepted by hook agent dispatch. */
export type { HookMessageChannel } from "./hooks.types.js";

const getHookChannelSet = () => new Set<string>(listHookChannelValues());
/** Render the current hook channel validation error from registered channel plugins. */
export const getHookChannelError = () => `channel must be ${listHookChannelValues().join("|")}`;

/** Resolve a raw hook channel value, defaulting omitted values to `last`. */
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

/** Resolve hook delivery opt-out; any value except false means deliver. */
export function resolveHookDeliver(raw: unknown): boolean {
  return raw !== false;
}

function resolveOptionalHookIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HOOK_IDEMPOTENCY_KEY_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/** Resolve the hook idempotency key from headers or payload within length limits. */
export function resolveHookIdempotencyKey(params: {
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): string | undefined {
  return (
    resolveOptionalHookIdempotencyKey(params.headers?.["idempotency-key"]) ||
    resolveOptionalHookIdempotencyKey(params.headers?.["x-openclaw-idempotency-key"]) ||
    resolveOptionalHookIdempotencyKey(params.payload.idempotencyKey)
  );
}

/** Resolve an optional hook target agent id to a known configured agent. */
export function resolveHookTargetAgentId(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): string | undefined {
  const raw = normalizeOptionalString(agentId);
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeAgentId(raw);
  if (hooksConfig.agentPolicy.knownAgentIds.has(normalized)) {
    return normalized;
  }
  return hooksConfig.agentPolicy.defaultAgentId;
}

/** Resolve the effective hook target agent, falling back to the hook default. */
export function resolveEffectiveHookTargetAgentId(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): string {
  return resolveHookTargetAgentId(hooksConfig, agentId) ?? hooksConfig.agentPolicy.defaultAgentId;
}

/** Check the hook agent allowlist against the effective target agent. */
export function isHookAgentAllowed(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): boolean {
  const allowed = hooksConfig.agentPolicy.allowedAgentIds;
  if (allowed === undefined) {
    return true;
  }
  // Omitted agentId still dispatches to the default agent downstream, so the
  // allowlist must authorize that effective target before dispatch.
  return allowed.has(resolveEffectiveHookTargetAgentId(hooksConfig, agentId));
}

/** Error message for hook agent allowlist failures. */
export const getHookAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
const getHookSessionKeyRequestPolicyError = () =>
  "sessionKey is disabled for externally supplied hook payload values; set hooks.allowRequestSessionKey=true to enable";
/** Error message for hook session-key prefix allowlist failures. */
export const getHookSessionKeyPrefixError = (prefixes: string[]) =>
  `sessionKey must start with one of: ${prefixes.join(", ")}`;

/** Resolve the hook dispatch session key from request, mapping, default, or generated id. */
export function resolveHookSessionKey(params: {
  hooksConfig: HooksConfigResolved;
  source: HookSessionKeySource;
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const requested = resolveSessionKey(params.sessionKey);
  if (requested) {
    if (
      (params.source === "request" || params.source === "mapping-templated") &&
      !params.hooksConfig.sessionPolicy.allowRequestSessionKey
    ) {
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

function hasTemplatedHookSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && hasHookTemplateExpressions(sessionKey);
}

function hasEffectiveTemplatedHookSessionKeyMapping(mappings: HookMappingResolved[]): boolean {
  const effectiveMappings: HookMappingResolved[] = [];
  for (const mapping of mappings) {
    if (isHookMappingShadowed(mapping, effectiveMappings)) {
      continue;
    }
    effectiveMappings.push(mapping);
    if (mapping.action === "agent" && hasTemplatedHookSessionKey(mapping.sessionKey)) {
      return true;
    }
  }
  return false;
}

function isHookMappingShadowed(
  mapping: HookMappingResolved,
  earlierMappings: HookMappingResolved[],
): boolean {
  return earlierMappings.some((earlier) => {
    if (earlier.matchPath && earlier.matchPath !== mapping.matchPath) {
      return false;
    }
    return !earlier.matchSource || earlier.matchSource === mapping.matchSource;
  });
}

/** Re-scope agent-prefixed hook session keys to the selected target agent. */
export function normalizeHookDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  const trimmed = normalizeOptionalString(params.sessionKey) ?? "";
  if (!trimmed || !params.targetAgentId) {
    return trimmed;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  return `agent:${targetAgentId}:${parsed.rest}`;
}

/** Validate and normalize a hook agent payload before policy/session resolution. */
export function normalizeAgentPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      value: HookAgentPayload;
    }
  | { ok: false; error: string } {
  const message = normalizeOptionalString(payload.message) ?? "";
  if (!message) {
    return { ok: false, error: "message required" };
  }
  const nameRaw = payload.name;
  const name = normalizeOptionalString(nameRaw) ?? "Hook";
  const agentIdRaw = payload.agentId;
  const agentId = normalizeOptionalString(agentIdRaw);
  const idempotencyKey = resolveOptionalHookIdempotencyKey(payload.idempotencyKey);
  const wakeMode = payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const sessionKeyRaw = payload.sessionKey;
  const sessionKey = normalizeOptionalString(sessionKeyRaw);
  const channel = resolveHookChannel(payload.channel);
  if (!channel) {
    return { ok: false, error: getHookChannelError() };
  }
  const toRaw = payload.to;
  const to = normalizeOptionalString(toRaw);
  const modelRaw = payload.model;
  const model = normalizeOptionalString(modelRaw);
  if (modelRaw !== undefined && !model) {
    return { ok: false, error: "model required" };
  }
  const deliver = resolveHookDeliver(payload.deliver);
  const thinkingRaw = payload.thinking;
  const thinking = normalizeOptionalString(thinkingRaw);
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
      idempotencyKey,
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
