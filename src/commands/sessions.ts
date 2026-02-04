import type { RuntimeEnv } from "../runtime.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveFreshSessionTotalTokens,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { info } from "../globals.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { visibleWidth } from "../terminal/ansi.js";
import { isRich, theme } from "../terminal/theme.js";

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
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: string;
  groupActivation?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  model?: string;
  contextTokens?: number;
};

// Helper to pad a string to a target width, accounting for ANSI codes
const padToWidth = (text: string, width: number): string => {
  const visible = visibleWidth(text);
  if (visible >= width) {
    return text;
  }
  return text + " ".repeat(width - visible);
};

// Helper to truncate a plain string (no ANSI) to fit within a max width
const truncateText = (text: string, maxWidth: number): string => {
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 10) {
    return text.slice(0, maxWidth);
  }
  // Truncate with ellipsis: show start and end
  const head = Math.floor((maxWidth - 3) * 0.6);
  const tail = maxWidth - head - 3;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
};

const formatKTokens = (value: number) => `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) {
    return label;
  }
  if (pct >= 95) {
    return theme.error(label);
  }
  if (pct >= 80) {
    return theme.warn(label);
  }
  if (pct >= 60) {
    return theme.success(label);
  }
  return theme.muted(label);
};

const formatTokensCell = (
  total: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  if (total === undefined) {
    const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label) : label;
  }
  const totalLabel = formatKTokens(total);
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  const pct = contextTokens ? Math.min(999, Math.round((total / contextTokens) * 100)) : null;
  const label = `${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`;
  return colorByPct(label, pct, rich);
};

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  if (!rich) {
    return kind;
  }
  if (kind === "group") {
    return theme.accentBright(kind);
  }
  if (kind === "global") {
    return theme.warn(kind);
  }
  if (kind === "direct") {
    return theme.accent(kind);
  }
  return theme.muted(kind);
};

const formatAgeCell = (updatedAt: number | null | undefined, rich: boolean) => {
  const ageLabel = updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown";
  return rich ? theme.muted(ageLabel) : ageLabel;
};

const formatModelCell = (model: string | null | undefined, rich: boolean) => {
  const label = model ?? "unknown";
  return rich ? theme.info(label) : label;
};

const formatFlagsCell = (row: SessionRow, rich: boolean) => {
  const flags = [
    row.thinkingLevel ? `think:${row.thinkingLevel}` : null,
    row.verboseLevel ? `verbose:${row.verboseLevel}` : null,
    row.reasoningLevel ? `reasoning:${row.reasoningLevel}` : null,
    row.elevatedLevel ? `elev:${row.elevatedLevel}` : null,
    row.responseUsage ? `usage:${row.responseUsage}` : null,
    row.groupActivation ? `activation:${row.groupActivation}` : null,
    row.systemSent ? "system" : null,
    row.abortedLastRun ? "aborted" : null,
    row.sessionId ? `id:${row.sessionId}` : null,
  ].filter(Boolean);
  const label = flags.join(" ");
  return label.length === 0 ? "" : rich ? theme.muted(label) : label;
};

function classifyKey(key: string, entry?: SessionEntry): SessionRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

function toRows(store: Record<string, SessionEntry>): SessionRow[] {
  return Object.entries(store)
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      return {
        key,
        kind: classifyKey(key, entry),
        updatedAt,
        ageMs: updatedAt ? Date.now() - updatedAt : null,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        responseUsage: entry?.responseUsage,
        groupActivation: entry?.groupActivation,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: entry?.totalTokens,
        totalTokensFresh: entry?.totalTokensFresh,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
      } satisfies SessionRow;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function sessionsCommand(
  opts: { json?: boolean; store?: string; active?: string },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configContextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const storePath = resolveStorePath(opts.store ?? cfg.session?.store);
  const store = loadSessionStore(storePath);

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = Number.parseInt(String(opts.active), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      runtime.error("--active must be a positive integer (minutes)");
      runtime.exit(1);
      return;
    }
    activeMinutes = parsed;
  }

  const rows = toRows(store).filter((row) => {
    if (activeMinutes === undefined) {
      return true;
    }
    if (!row.updatedAt) {
      return false;
    }
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
            totalTokens: resolveFreshSessionTotalTokens(r) ?? null,
            totalTokensFresh:
              typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
            contextTokens:
              r.contextTokens ?? lookupContextTokens(r.model) ?? configContextTokens ?? null,
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

  const rich = isRich();
  const terminalWidth = Math.max(80, (process.stdout.columns ?? 120) - 2);

  // Calculate dynamic column widths based on terminal size
  // Fixed columns: Kind (7), Age (10), Tokens (20)
  // Variable columns: Key and Model share remaining space, Flags gets what's left
  const fixedWidth = 7 + 10 + 20 + 5; // columns + spaces between
  const remainingWidth = Math.max(40, terminalWidth - fixedWidth);

  // Allocate space: Key gets 30-50% of remaining, Model gets 20-40%, Flags gets rest
  const keyWidth = Math.max(20, Math.min(50, Math.floor(remainingWidth * 0.35)));
  const modelWidth = Math.max(18, Math.min(35, Math.floor(remainingWidth * 0.25)));

  const KIND_WIDTH = 7;
  const AGE_WIDTH = 10;
  const TOKENS_WIDTH = 20;

  const header = [
    padToWidth("Kind", KIND_WIDTH),
    padToWidth("Key", keyWidth),
    padToWidth("Age", AGE_WIDTH),
    padToWidth("Model", modelWidth),
    padToWidth("Tokens (ctx %)", TOKENS_WIDTH),
    "Flags",
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const model = row.model ?? configModel;
    const contextTokens = row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
    const total = resolveFreshSessionTotalTokens(row);

    // Truncate text before applying colors
    const truncatedKey = truncateText(row.key, keyWidth);
    const truncatedModel = truncateText(model, modelWidth);

    const kindCell = formatKindCell(row.kind, rich);
    const keyCell = rich ? theme.accent(truncatedKey) : truncatedKey;
    const ageCell = formatAgeCell(row.updatedAt, rich);
    const modelCell = formatModelCell(truncatedModel, rich);
    const tokensCell = formatTokensCell(total, contextTokens ?? null, rich);
    const flagsCell = formatFlagsCell(row, rich);

    const line = [
      padToWidth(kindCell, KIND_WIDTH),
      padToWidth(keyCell, keyWidth),
      padToWidth(ageCell, AGE_WIDTH),
      padToWidth(modelCell, modelWidth),
      padToWidth(tokensCell, TOKENS_WIDTH),
      flagsCell,
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}
