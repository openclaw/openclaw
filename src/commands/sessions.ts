import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL } from "../agents/defaults.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";

type SessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  updatedAt: number | null;
  ageMs: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
};

const formatAge = (ms: number | null | undefined) => {
  if (!ms || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

function classifyKey(key: string): SessionRow["kind"] {
  if (key === "global") return "global";
  if (key.startsWith("group:")) return "group";
  if (key === "unknown") return "unknown";
  return "direct";
}

function toRows(store: Record<string, SessionEntry>): SessionRow[] {
  return Object.entries(store)
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      return {
        key,
        kind: classifyKey(key),
        updatedAt,
        ageMs: updatedAt ? Date.now() - updatedAt : null,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: entry?.totalTokens,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
      } satisfies SessionRow;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function sessionsCommand(
  opts: { json?: boolean; store?: string; active?: string },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const configContextTokens =
    cfg.inbound?.reply?.agent?.contextTokens ??
    lookupContextTokens(cfg.inbound?.reply?.agent?.model) ??
    DEFAULT_CONTEXT_TOKENS;
  const configModel = cfg.inbound?.reply?.agent?.model ?? DEFAULT_MODEL;
  const storePath = resolveStorePath(
    opts.store ?? cfg.inbound?.reply?.session?.store,
  );
  const store = loadSessionStore(storePath);

  const activeMinutes = opts.active
    ? Number.parseInt(String(opts.active), 10)
    : undefined;
  if (
    opts.active !== undefined &&
    (Number.isNaN(activeMinutes) || activeMinutes <= 0)
  ) {
    runtime.error("--active must be a positive integer (minutes)");
    runtime.exit(1);
    return;
  }

  const rows = toRows(store).filter((row) => {
    if (!activeMinutes) return true;
    if (!row.updatedAt) return false;
    return Date.now() - row.updatedAt <= activeMinutes * 60_000;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          path: storePath,
          count: rows.length,
          activeMinutes: activeMinutes ?? null,
          sessions: rows.map((r) => ({
            ...r,
            contextTokens:
              r.contextTokens ??
              lookupContextTokens(r.model) ??
              configContextTokens ??
              null,
            model: r.model ?? configModel ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Session store: ${storePath}`));
  runtime.log(info(`Sessions listed: ${rows.length}`));
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  for (const row of rows) {
    const model = row.model ?? configModel;
    const contextTokens =
      row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
    const input = row.inputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    const total = row.totalTokens ?? input + output;
    const pct = contextTokens
      ? `${Math.min(100, Math.round((total / contextTokens) * 100))}%`
      : null;

    const parts = [
      `${row.key} [${row.kind}]`,
      row.updatedAt ? formatAge(Date.now() - row.updatedAt) : "age unknown",
    ];
    if (row.sessionId) parts.push(`id ${row.sessionId}`);
    if (row.thinkingLevel) parts.push(`think=${row.thinkingLevel}`);
    if (row.verboseLevel) parts.push(`verbose=${row.verboseLevel}`);
    if (row.systemSent) parts.push("systemSent");
    if (row.abortedLastRun) parts.push("aborted");
    if (total > 0) {
      const tokenStr = `tokens in:${input} out:${output} total:${total}`;
      parts.push(
        contextTokens ? `${tokenStr} (${pct} of ${contextTokens})` : tokenStr,
      );
    }
    if (model) parts.push(`model=${model}`);
    runtime.log(`- ${parts.join(" | ")}`);
  }
}
