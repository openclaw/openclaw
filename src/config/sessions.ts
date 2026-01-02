import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Skill } from "@mariozechner/pi-coding-agent";
import JSON5 from "json5";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeE164 } from "../utils.js";

export type SessionScope = "per-sender" | "global";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  providerOverride?: string;
  modelOverride?: string;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  queueMode?: "queue" | "interrupt";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
  lastChannel?:
    | "whatsapp"
    | "telegram"
    | "discord"
    | "signal"
    | "imessage"
    | "webchat";
  lastTo?: string;
  skillsSnapshot?: SessionSkillSnapshot;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
};

export function resolveSessionTranscriptsDir(): string {
  return path.join(os.homedir(), ".clawdis", "sessions");
}

export function resolveDefaultSessionStorePath(): string {
  return path.join(resolveSessionTranscriptsDir(), "sessions.json");
}
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveSessionTranscriptPath(sessionId: string): string {
  return path.join(resolveSessionTranscriptsDir(), `${sessionId}.jsonl`);
}

export function resolveStorePath(store?: string) {
  if (!store) return resolveDefaultSessionStorePath();
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
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    await fs.promises.rename(tmp, storePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, "utf-8");
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
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
    providerOverride: existing?.providerOverride,
    modelOverride: existing?.modelOverride,
    queueMode: existing?.queueMode,
    inputTokens: existing?.inputTokens,
    outputTokens: existing?.outputTokens,
    totalTokens: existing?.totalTokens,
    model: existing?.model,
    contextTokens: existing?.contextTokens,
    skillsSnapshot: existing?.skillsSnapshot,
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
