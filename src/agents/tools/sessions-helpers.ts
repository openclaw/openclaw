import type { ClawdbotConfig } from "../../config/config.js";

export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

function normalizeKey(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveMainSessionAlias(cfg: ClawdbotConfig) {
  const mainKey = normalizeKey(cfg.session?.mainKey) ?? "main";
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
}) {
  if (params.key === params.alias) return "main";
  if (params.key === params.mainKey) return "main";
  return params.key;
}

export function resolveInternalSessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
}) {
  if (params.key === "main") return params.alias;
  return params.key;
}

export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) return "main";
  if (key.startsWith("cron:")) return "cron";
  if (key.startsWith("hook:")) return "hook";
  if (key.startsWith("node-") || key.startsWith("node:")) return "node";
  if (params.gatewayKind === "group") return "group";
  if (
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:")
  ) {
    return "group";
  }
  return "other";
}

export function deriveProvider(params: {
  key: string;
  kind: SessionKind;
  provider?: string | null;
  lastProvider?: string | null;
}): string {
  if (
    params.kind === "cron" ||
    params.kind === "hook" ||
    params.kind === "node"
  )
    return "internal";
  const provider = normalizeKey(params.provider ?? undefined);
  if (provider) return provider;
  const lastProvider = normalizeKey(params.lastProvider ?? undefined);
  if (lastProvider) return lastProvider;
  const parts = params.key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts[0];
  }
  return "unknown";
}

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") return true;
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult";
  });
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type !== "text") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      chunks.push(text);
    }
  }
  const joined = chunks.join("").trim();
  return joined ? joined : undefined;
}
