import type { IncomingMessage } from "node:http";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { type HookMappingResolved, resolveHookMappings } from "./hooks-mapping.js";
import {
  getIngressAgentPolicyError,
  getIngressSessionKeyPrefixError,
  getIngressSessionKeyRequestPolicyError,
  isIngressAgentAllowed,
  normalizeIngressDispatchSessionKey,
  resolveAllowedAgentIds,
  resolveIngressDispatchPolicies,
  resolveIngressSessionKey,
  resolveIngressTargetAgentId,
  type IngressAgentPolicyResolved,
  type IngressDispatchPoliciesResolved,
  type IngressSessionPolicyResolved,
} from "./ingress-policy.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;
const MAX_HOOK_IDEMPOTENCY_KEY_LENGTH = 256;

export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  agentPolicy: IngressAgentPolicyResolved;
  sessionPolicy: IngressSessionPolicyResolved;
};

export type HookAgentPolicyResolved = IngressAgentPolicyResolved;
export type HookSessionPolicyResolved = IngressSessionPolicyResolved;
export type HookIngressPoliciesResolved = IngressDispatchPoliciesResolved;
export { resolveAllowedAgentIds };

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
  const policies = resolveIngressDispatchPolicies(cfg);
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    ...policies,
  };
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

export type HookAgentDispatchPayload = Omit<HookAgentPayload, "sessionKey"> & {
  sessionKey: string;
  allowUnsafeExternalContent?: boolean;
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

export const resolveHookIngressPolicies = resolveIngressDispatchPolicies;

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
export function resolveHookTargetAgentId(
  hooksConfig: HooksConfigResolved | IngressDispatchPoliciesResolved,
  agentId: string | undefined,
): string | undefined {
  return resolveIngressTargetAgentId(hooksConfig, agentId);
}
export function isHookAgentAllowed(
  hooksConfig: HooksConfigResolved | IngressDispatchPoliciesResolved,
  agentId: string | undefined,
): boolean {
  return isIngressAgentAllowed(hooksConfig, agentId);
}
export const getHookAgentPolicyError = getIngressAgentPolicyError;
export const getHookSessionKeyRequestPolicyError = getIngressSessionKeyRequestPolicyError;
export const getHookSessionKeyPrefixError = getIngressSessionKeyPrefixError;
export function resolveHookSessionKey(params: {
  hooksConfig?: HooksConfigResolved;
  policies?: IngressDispatchPoliciesResolved;
  source: "request" | "mapping";
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const policies = params.policies ?? params.hooksConfig;
  if (!policies) {
    throw new Error("resolveHookSessionKey requires hooksConfig or policies");
  }
  return resolveIngressSessionKey({
    policies,
    source: params.source,
    sessionKey: params.sessionKey,
    idFactory: params.idFactory,
  });
}
export function normalizeHookDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  return normalizeIngressDispatchSessionKey(params);
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
  const idempotencyKey = resolveOptionalHookIdempotencyKey(payload.idempotencyKey);
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
