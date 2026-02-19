import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const MemoryWriteSchema = Type.Object({
  text: Type.String(),
  target: optionalStringEnum(["daily", "longterm"]),
  date: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
});

const MemoryUpsertSchema = Type.Object({
  key: Type.String(),
  text: Type.String(),
  target: optionalStringEnum(["daily", "longterm"]),
  date: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
});

const memoryFileLocks = new Map<string, Promise<void>>();

async function withMemoryFileLock<T>(absPath: string, action: () => Promise<T>): Promise<T> {
  const lockKey = path.resolve(absPath);
  const previous = memoryFileLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(() => current);
  memoryFileLocks.set(lockKey, queued);
  await previous;
  try {
    return await action();
  } finally {
    releaseCurrent?.();
    if (memoryFileLocks.get(lockKey) === queued) {
      memoryFileLocks.delete(lockKey);
    }
  }
}

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

function resolveMemoryWriteToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return {
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(buildMemorySearchUnavailableResult(message));
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

export function createMemoryWriteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryWriteToolContext(options);
  if (!ctx) {
    return null;
  }
  return {
    label: "Memory Write",
    name: "memory_write",
    description:
      "Append a durable note to MEMORY.md or memory/YYYY-MM-DD.md. Use when the user says to remember something.",
    parameters: MemoryWriteSchema,
    execute: async (_toolCallId, params) => {
      const text = normalizeMemoryText(readStringParam(params, "text", { required: true }));
      if (!text) {
        throw new Error("text is required");
      }
      const target = readMemoryTarget(params, "target", "daily");
      const requestedDate = readStringParam(params, "date");
      const date = normalizeMemoryDate(requestedDate);
      const entry = formatMemoryEntry({
        text,
        kind: readStringParam(params, "kind"),
        source: readStringParam(params, "source"),
        confidence: readNumberParam(params, "confidence"),
      });
      const absPath = resolveMemoryWritePath({
        workspaceDir: ctx.workspaceDir,
        target,
        date,
      });
      await withMemoryFileLock(absPath, async () => {
        await ensureMemoryFile(absPath);
        await fs.appendFile(absPath, `${entry}\n`, "utf-8");
      });
      return jsonResult({
        ok: true,
        target,
        path: asWorkspaceRelativePath(absPath, ctx.workspaceDir),
        date: target === "daily" ? date : undefined,
        appended: entry,
      });
    },
  };
}

export function createMemoryUpsertTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryWriteToolContext(options);
  if (!ctx) {
    return null;
  }
  return {
    label: "Memory Upsert",
    name: "memory_upsert",
    description:
      "Upsert a keyed durable note in MEMORY.md or memory/YYYY-MM-DD.md. Reuses key:<id> to update existing memory instead of appending duplicates.",
    parameters: MemoryUpsertSchema,
    execute: async (_toolCallId, params) => {
      const keyRaw = readStringParam(params, "key", { required: true });
      const key = normalizeMemoryKey(keyRaw);
      if (!key) {
        throw new Error("key is required");
      }
      const text = normalizeMemoryText(readStringParam(params, "text", { required: true }));
      if (!text) {
        throw new Error("text is required");
      }
      const target = readMemoryTarget(params, "target", "longterm");
      const requestedDate = readStringParam(params, "date");
      const date = normalizeMemoryDate(requestedDate);
      const body = formatMemoryEntry({
        text,
        kind: readStringParam(params, "kind"),
        source: readStringParam(params, "source"),
        confidence: readNumberParam(params, "confidence"),
      });
      const entry = `- [key:${key}] ${body.slice(2)}`;
      const absPath = resolveMemoryWritePath({
        workspaceDir: ctx.workspaceDir,
        target,
        date,
      });
      const updated = await withMemoryFileLock(absPath, async () => {
        await ensureMemoryFile(absPath);
        let current = "";
        try {
          current = await fs.readFile(absPath, "utf-8");
        } catch {
          current = "";
        }
        const lines = current.length > 0 ? current.split(/\r?\n/) : [];
        while (lines.length > 0 && lines.at(-1) === "") {
          lines.pop();
        }
        const prefix = `- [key:${key}] `;
        const existingIndex = lines.findIndex((line) => line.startsWith(prefix));
        const alreadyExists = existingIndex >= 0;
        if (alreadyExists) {
          lines[existingIndex] = entry;
        } else {
          lines.push(entry);
        }
        await fs.writeFile(absPath, `${lines.join("\n")}\n`, "utf-8");
        return alreadyExists;
      });
      return jsonResult({
        ok: true,
        updated,
        key,
        target,
        path: asWorkspaceRelativePath(absPath, ctx.workspaceDir),
        date: target === "daily" ? date : undefined,
        value: entry,
      });
    },
  };
}

function readMemoryTarget(
  params: Record<string, unknown>,
  field: string,
  fallback: "daily" | "longterm",
): "daily" | "longterm" {
  const raw = readStringParam(params, field)?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "daily" || raw === "longterm") {
    return raw;
  }
  throw new Error(`${field} must be "daily" or "longterm"`);
}

function normalizeMemoryDate(raw?: string): string {
  if (!raw) {
    return new Date().toISOString().slice(0, 10);
  }
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`date must be YYYY-MM-DD`);
  }
  return trimmed;
}

function normalizeMemoryText(raw: string): string {
  return raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMemoryKey(raw: string): string {
  return raw
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .trim()
    .toLowerCase();
}

function formatMemoryEntry(params: {
  text: string;
  kind?: string;
  source?: string;
  confidence?: number;
}): string {
  const meta: string[] = [];
  const kind = params.kind?.trim();
  if (kind) {
    meta.push(`kind:${kind}`);
  }
  const source = params.source?.trim();
  if (source) {
    meta.push(`source:${source}`);
  }
  if (typeof params.confidence === "number" && Number.isFinite(params.confidence)) {
    const clamped = Math.max(0, Math.min(1, params.confidence));
    meta.push(`confidence:${clamped.toFixed(2)}`);
  }
  const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
  return `- ${params.text}${suffix}`;
}

function resolveMemoryWritePath(params: {
  workspaceDir: string;
  target: "daily" | "longterm";
  date: string;
}): string {
  if (params.target === "longterm") {
    return path.join(params.workspaceDir, "MEMORY.md");
  }
  return path.join(params.workspaceDir, "memory", `${params.date}.md`);
}

async function ensureMemoryFile(absPath: string) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  try {
    await fs.access(absPath);
  } catch {
    await fs.writeFile(absPath, "", "utf-8");
  }
}

function asWorkspaceRelativePath(absPath: string, workspaceDir: string): string {
  const rel = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    return path.basename(absPath);
  }
  return rel;
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
