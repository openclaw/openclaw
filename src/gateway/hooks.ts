import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
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

export type ReadHookBodyResult = { ok: true; value: unknown } | { ok: false; error: string };

export type FormspreeInquiryCategory =
  | "inquiry"
  | "document_request"
  | "consultation"
  | "sales"
  | "other";

export type FormspreeInquiryEvent = {
  type: "visitor.inquiry.detected";
  source: "formspree";
  received_at: string;
  has_sender: boolean;
  has_subject: boolean;
  raw_subject?: string;
  category: FormspreeInquiryCategory;
};

export type FormspreeIntakeSession = {
  session_type: "formspree_intake_session";
  source: "formspree";
  received_at: string;
  public_event: FormspreeInquiryEvent;
  contact: {
    has_email: boolean;
    has_company: boolean;
    has_phone: boolean;
    has_message: boolean;
  };
  routing: {
    category: FormspreeInquiryCategory;
    service?: string;
    initial_owner: "ops";
  };
  raw: {
    email?: string;
    company?: string;
    phone?: string;
    service?: string;
    subject?: string;
    message?: string;
  };
};

function getRequestContentType(req: IncomingMessage): string {
  const raw = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  return typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() : "";
}

function getMultipartBoundary(req: IncomingMessage): string | null {
  const raw = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/boundary=([^;]+)/i);
  return match?.[1]?.trim().replace(/^"|"$/g, "") || null;
}

function assignHookField(target: Record<string, unknown>, key: string, value: string) {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  target[key] = [existing, value];
}

function parseUrlEncodedHookBody(raw: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const params = new URLSearchParams(raw);
  for (const [key, value] of params.entries()) {
    assignHookField(payload, key, value);
  }
  return payload;
}

function parseMultipartHookBody(raw: string, boundary: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const delimiter = `--${boundary}`;
  for (const chunk of raw.split(delimiter)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const normalized = trimmed.replace(/^\r\n/, "").replace(/\r\n--$/, "");
    const splitAt = normalized.indexOf("\r\n\r\n");
    if (splitAt === -1) {
      continue;
    }
    const headerBlock = normalized.slice(0, splitAt);
    const bodyBlock = normalized.slice(splitAt + 4).replace(/\r\n$/, "");
    const disposition = headerBlock
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (!disposition) {
      continue;
    }
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    if (!nameMatch || filenameMatch) {
      continue;
    }
    assignHookField(payload, nameMatch[1], bodyBlock);
  }
  return payload;
}

function firstStringField(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return undefined;
}

function classifyFormspreeCategory(text: string): FormspreeInquiryCategory {
  if (!text) {
    return "other";
  }
  if (text.includes("見積")) {
    return "inquiry";
  }
  if (text.includes("資料")) {
    return "document_request";
  }
  if (text.includes("相談")) {
    return "consultation";
  }
  if (text.includes("営業")) {
    return "sales";
  }
  return "other";
}

export async function readHookBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadHookBodyResult> {
  const contentType = getRequestContentType(req);
  if (!contentType || contentType === "application/json" || contentType.endsWith("+json")) {
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

  try {
    const raw = await readRequestBodyWithLimit(req, { maxBytes });
    if (!raw.trim()) {
      return { ok: true, value: {} };
    }
    if (contentType === "application/x-www-form-urlencoded") {
      return { ok: true, value: parseUrlEncodedHookBody(raw) };
    }
    if (contentType === "multipart/form-data") {
      const boundary = getMultipartBoundary(req);
      if (!boundary) {
        return { ok: false, error: "multipart boundary missing" };
      }
      return { ok: true, value: parseMultipartHookBody(raw, boundary) };
    }
    return { ok: false, error: `unsupported content type: ${contentType}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Payload too large")) {
      return { ok: false, error: "payload too large" };
    }
    if (message.includes("Request body timeout")) {
      return { ok: false, error: "request body timeout" };
    }
    if (message.includes("Connection closed")) {
      return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
    }
    return { ok: false, error: message };
  }
}

export function buildFormspreeIntakeSession(
  payload: Record<string, unknown>,
  now = new Date(),
): FormspreeIntakeSession {
  const email = firstStringField(payload, ["email", "_replyto", "from", "sender"]);
  const company = firstStringField(payload, ["company", "organization", "organisation"]);
  const phone = firstStringField(payload, ["phone", "tel", "telephone"]);
  const service = firstStringField(payload, ["service", "service_type", "serviceType"]);
  const rawSubject = firstStringField(payload, ["subject", "_subject"]);
  const message = firstStringField(payload, ["message", "body", "content", "details"]);
  const classificationText = [service, rawSubject, message].filter(Boolean).join("\n");
  const category = classifyFormspreeCategory(classificationText);
  const receivedAt = now.toISOString();
  const publicEvent: FormspreeInquiryEvent = {
    type: "visitor.inquiry.detected",
    source: "formspree",
    received_at: receivedAt,
    has_sender: Boolean(email),
    has_subject: Boolean(rawSubject || message),
    raw_subject: rawSubject,
    category,
  };
  return {
    session_type: "formspree_intake_session",
    source: "formspree",
    received_at: receivedAt,
    public_event: publicEvent,
    contact: {
      has_email: Boolean(email),
      has_company: Boolean(company),
      has_phone: Boolean(phone),
      has_message: Boolean(message),
    },
    routing: {
      category,
      service,
      initial_owner: "ops",
    },
    raw: {
      email,
      company,
      phone,
      service,
      subject: rawSubject,
      message,
    },
  };
}

export function normalizeFormspreeInquiryPayload(
  payload: Record<string, unknown>,
  now = new Date(),
): FormspreeInquiryEvent {
  return buildFormspreeIntakeSession(payload, now).public_event;
}

export function buildFormspreeOpsHookMessage(session: FormspreeIntakeSession): string {
  const event = session.public_event;
  return [
    "Formspree inquiry intake session detected.",
    `session_type=${session.session_type}`,
    `type=${event.type}`,
    `source=${event.source}`,
    `received_at=${event.received_at}`,
    `has_sender=${event.has_sender ? "true" : "false"}`,
    `has_subject=${event.has_subject ? "true" : "false"}`,
    `category=${event.category}`,
    `service=${session.routing.service ?? ""}`,
    `raw_subject=${event.raw_subject ?? ""}`,
    `email=${session.raw.email ?? ""}`,
    `company=${session.raw.company ?? ""}`,
    `phone=${session.raw.phone ?? ""}`,
    `message=${session.raw.message ?? ""}`,
    "Keep raw inquiry details internal. Public scene should use only visitor.inquiry.detected.",
  ].join("\n");
}

export function buildFormspreeInquiryId(session: FormspreeIntakeSession): string {
  const digest = createHash("sha256")
    .update(
      [
        session.raw.email ?? "",
        session.raw.company ?? "",
        session.raw.phone ?? "",
        session.raw.service ?? "",
        session.raw.subject ?? "",
        session.raw.message ?? "",
        session.public_event.category,
      ].join("\u001f"),
      "utf8",
    )
    .digest("hex");
  return digest.slice(0, 12);
}

export function buildFormspreeVisibleSessionMessage(session: FormspreeIntakeSession): string {
  const event = session.public_event;
  return [
    "Formspree inquiry marker for Control UI.",
    `type=${event.type}`,
    `received_at=${event.received_at}`,
    `category=${event.category}`,
    `service=${session.routing.service ?? ""}`,
    `has_email=${session.contact.has_email ? "true" : "false"}`,
    `has_company=${session.contact.has_company ? "true" : "false"}`,
    `has_phone=${session.contact.has_phone ? "true" : "false"}`,
    `has_message=${session.contact.has_message ? "true" : "false"}`,
    "This session is a lightweight intake marker only.",
    "Do not expose raw contact details or message body here.",
    "If no follow-up is needed, reply only with NO_REPLY.",
  ].join("\n");
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

export function normalizeHookDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  const trimmed = params.sessionKey.trim();
  if (!trimmed || !params.targetAgentId) {
    return trimmed;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (parsed.agentId !== targetAgentId) {
    return `agent:${parsed.agentId}:${parsed.rest}`;
  }
  return parsed.rest;
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
