import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import type { MsgContext } from "../auto-reply/templating.js";
import { CONFIG_DIR, normalizeE164 } from "../utils.js";

export type SessionScope = "per-sender" | "global";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
  lastChannel?: "whatsapp" | "telegram" | "webchat";
  lastTo?: string;
  // Optional flag to mirror Mac app UI and future sync states.
  syncing?: boolean | string;
};

export const SESSION_STORE_DEFAULT = path.join(
  CONFIG_DIR,
  "sessions",
  "sessions.json",
);
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveStorePath(store?: string) {
  if (!store) return SESSION_STORE_DEFAULT;
  if (store.startsWith("~"))
    return path.resolve(store.replace("~", os.homedir()));
  return path.resolve(store);
}

export function loadSessionStore(
  storePath: string,
): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, SessionEntry>;
    }
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }
  return {};
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.promises.rename(tmp, storePath);
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to?: string;
}) {
  const { storePath, sessionKey, channel, to } = params;
  const store = loadSessionStore(storePath);
  const existing = store[sessionKey];
  const now = Date.now();
  const next: SessionEntry = {
    sessionId: existing?.sessionId ?? crypto.randomUUID(),
    updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    systemSent: existing?.systemSent,
    abortedLastRun: existing?.abortedLastRun,
    thinkingLevel: existing?.thinkingLevel,
    verboseLevel: existing?.verboseLevel,
    inputTokens: existing?.inputTokens,
    outputTokens: existing?.outputTokens,
    totalTokens: existing?.totalTokens,
    model: existing?.model,
    contextTokens: existing?.contextTokens,
    syncing: existing?.syncing,
    lastChannel: channel,
    lastTo: to?.trim() ? to.trim() : undefined,
  };
  store[sessionKey] = next;
  await saveSessionStore(storePath, store);
  return next;
}

// Decide which session bucket to use (per-sender vs global).
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") return "global";
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  // Preserve group conversations as distinct buckets
  if (typeof ctx.From === "string" && ctx.From.includes("@g.us")) {
    return `group:${ctx.From}`;
  }
  if (typeof ctx.From === "string" && ctx.From.startsWith("group:")) {
    return ctx.From;
  }
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
) {
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") return raw;
  // Default to a single shared direct-chat session called "main"; groups stay isolated.
  const canonical = (mainKey ?? "main").trim() || "main";
  const isGroup = raw.startsWith("group:") || raw.includes("@g.us");
  if (!isGroup) return canonical;
  return raw;
}
