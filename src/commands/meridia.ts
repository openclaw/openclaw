import fs from "node:fs/promises";
import path from "node:path";
import type { MeridiaTraceEvent } from "../meridia/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { loadConfig } from "../config/config.js";
import { resolveHookConfig } from "../hooks/config.js";
import { MERIDIA_DEFAULT_EVALUATION_MODEL } from "../meridia/constants.js";
import { dateKeyUtc, resolveMeridiaDir } from "../meridia/storage.js";
import { theme } from "../terminal/theme.js";

export type MeridiaStatusOptions = {
  json?: boolean;
  since?: string;
};

export type MeridiaDoctorOptions = {
  json?: boolean;
};

function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = (match[2] ?? "h").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return value * mult;
}

async function readJsonlIfExists(filePath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return [];
      }
    }
    throw err;
  }
}

function* dateKeysBetweenUtc(startMs: number, endMs: number): Generator<string> {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= endDay) {
    yield dateKeyUtc(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function asTraceEvent(value: unknown): MeridiaTraceEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }
  if (
    type !== "tool_result" &&
    type !== "precompact" &&
    type !== "compaction_end" &&
    type !== "session_end"
  ) {
    return null;
  }
  return value as MeridiaTraceEvent;
}

export async function meridiaStatusCommand(opts: MeridiaStatusOptions, runtime: RuntimeEnv) {
  const cfg = loadConfig();
  const meridiaDir = resolveMeridiaDir(cfg);
  const sinceMs = parseDurationMs(opts.since ?? "24h");
  if (!sinceMs) {
    runtime.error("--since must be a duration like 30m, 6h, 7d");
    runtime.exit(1);
  }

  const nowMs = Date.now();
  const startMs = nowMs - sinceMs;
  const traceDir = path.join(meridiaDir, "trace");

  const events: MeridiaTraceEvent[] = [];
  for (const dateKey of dateKeysBetweenUtc(startMs, nowMs)) {
    const filePath = path.join(traceDir, `${dateKey}.jsonl`);
    const rows = await readJsonlIfExists(filePath);
    for (const row of rows) {
      const evt = asTraceEvent(row);
      if (!evt) {
        continue;
      }
      const tsMs = Date.parse((evt as { ts?: string }).ts ?? "");
      if (!Number.isFinite(tsMs) || tsMs < startMs) {
        continue;
      }
      events.push(evt);
    }
  }

  const toolEvents = events.filter((e) => e.type === "tool_result") as Array<
    Extract<MeridiaTraceEvent, { type: "tool_result" }>
  >;
  const captured = toolEvents.filter((e) => e.decision === "capture");
  const skipped = toolEvents.filter((e) => e.decision === "skip");
  const errors = toolEvents.filter((e) => e.decision === "error");
  const compactions = events.filter((e) => e.type === "precompact").length;
  const compactionEnds = events.filter((e) => e.type === "compaction_end").length;
  const sessionEnds = events.filter((e) => e.type === "session_end").length;

  const byTool = new Map<string, { seen: number; captured: number; errors: number }>();
  for (const evt of toolEvents) {
    const key = evt.toolName ?? "unknown";
    const entry = byTool.get(key) ?? { seen: 0, captured: 0, errors: 0 };
    entry.seen += 1;
    if (evt.decision === "capture") {
      entry.captured += 1;
    }
    if (evt.decision === "error") {
      entry.errors += 1;
    }
    byTool.set(key, entry);
  }

  const lastCapture = captured
    .map((e) => ({ ts: e.ts, tsMs: Date.parse(e.ts) }))
    .filter((e) => Number.isFinite(e.tsMs))
    .toSorted((a, b) => b.tsMs - a.tsMs)[0]?.ts;

  const summary = {
    since: new Date(startMs).toISOString(),
    now: new Date(nowMs).toISOString(),
    meridiaDir,
    toolResults: toolEvents.length,
    captured: captured.length,
    skipped: skipped.length,
    errors: errors.length,
    captureRate: toolEvents.length > 0 ? captured.length / toolEvents.length : 0,
    compactions,
    compactionEnds,
    sessionEnds,
    lastCaptureAt: lastCapture ?? null,
    topTools: Array.from(byTool.entries())
      .map(([tool, stats]) => ({ tool, ...stats }))
      .toSorted((a, b) => b.captured - a.captured || b.seen - a.seen)
      .slice(0, 8),
  };

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return;
  }

  runtime.log(theme.heading("Meridia Status"));
  runtime.log(`${theme.muted("Dir:")} ${meridiaDir}`);
  runtime.log(
    `${theme.muted("Since:")} ${summary.since} ${theme.muted("·")} tool=${summary.toolResults} captured=${summary.captured} skipped=${summary.skipped} err=${summary.errors}`,
  );
  runtime.log(
    `${theme.muted("Compaction:")} pre=${compactions} end=${compactionEnds} ${theme.muted("·")} ${theme.muted("Sessions:")} end=${sessionEnds}`,
  );
  if (summary.lastCaptureAt) {
    runtime.log(`${theme.muted("Last capture:")} ${summary.lastCaptureAt}`);
  }
  if (summary.topTools.length > 0) {
    const lines = summary.topTools.map(
      (t) =>
        `- ${t.tool}: captured=${t.captured} seen=${t.seen}${t.errors ? ` err=${t.errors}` : ""}`,
    );
    runtime.log(`${theme.muted("Top tools:")}\n${lines.join("\n")}`);
  }
}

export async function meridiaDoctorCommand(opts: MeridiaDoctorOptions, runtime: RuntimeEnv) {
  const cfg = loadConfig();
  const meridiaDir = resolveMeridiaDir(cfg);

  const internalEnabled = cfg.hooks?.internal?.enabled === true;
  const experientialCfg = resolveHookConfig(cfg, "experiential-capture");
  const compactionCfg = resolveHookConfig(cfg, "compaction");
  const sessionEndCfg = resolveHookConfig(cfg, "session-end");

  const configEvaluationModel =
    (typeof experientialCfg?.evaluation_model === "string" &&
    experientialCfg.evaluation_model.trim()
      ? experientialCfg.evaluation_model.trim()
      : undefined) ??
    (typeof experientialCfg?.evaluationModel === "string" && experientialCfg.evaluationModel.trim()
      ? experientialCfg.evaluationModel.trim()
      : undefined);

  const evaluationModelRaw = MERIDIA_DEFAULT_EVALUATION_MODEL;

  let googleAuthOk = false;
  let googleAuthSource = "";
  let googleAuthMode = "";
  let googleKeyLength = 0;
  try {
    const auth = await resolveApiKeyForProvider({ provider: "google", cfg });
    googleAuthOk = Boolean(auth.apiKey);
    googleAuthSource = auth.source;
    googleAuthMode = auth.mode;
    googleKeyLength = auth.apiKey ? auth.apiKey.length : 0;
  } catch (err) {
    googleAuthOk = false;
    googleAuthSource = err instanceof Error ? err.message : String(err);
  }

  const report = {
    meridiaDir,
    googleAuth: {
      ok: googleAuthOk,
      source: googleAuthSource,
      mode: googleAuthMode || null,
      keyLength: googleKeyLength,
    },
    hooks: {
      internalEnabled,
      experientialCapture: {
        enabled: experientialCfg?.enabled === true,
        configEvaluationModel: configEvaluationModel ?? null,
        evaluationModel: evaluationModelRaw,
        expectedModel: MERIDIA_DEFAULT_EVALUATION_MODEL,
        modelMatchesExpected: evaluationModelRaw === MERIDIA_DEFAULT_EVALUATION_MODEL,
        note: "experiential-capture evaluation model is fixed in code; config overrides are ignored.",
      },
      compaction: { enabled: compactionCfg?.enabled === true },
      sessionEnd: { enabled: sessionEndCfg?.enabled === true },
    },
    fix: {
      enableInternalHooks: "openclaw config set hooks.internal.enabled true --json",
      enableExperientialCapture:
        'openclaw config set hooks.internal.entries["experiential-capture"].enabled true --json',
      setExperientialModel: `openclaw config set hooks.internal.entries[\"experiential-capture\"].evaluation_model ${MERIDIA_DEFAULT_EVALUATION_MODEL}  # optional (ignored by code)`,
      enableCompaction: "openclaw config set hooks.internal.entries.compaction.enabled true --json",
      enableSessionEnd:
        'openclaw config set hooks.internal.entries["session-end"].enabled true --json',
      configureGoogle: "openclaw configure --section model  # choose Gemini (uses GEMINI_API_KEY)",
    },
  };

  if (opts.json) {
    runtime.log(JSON.stringify(report, null, 2));
    return;
  }

  runtime.log(theme.heading("Meridia Doctor"));
  runtime.log(`${theme.muted("Dir:")} ${meridiaDir}`);
  runtime.log(
    `${theme.muted("Google auth:")} ${googleAuthOk ? theme.success("ok") : theme.error("missing")} ${googleAuthOk ? theme.muted(`(${googleAuthSource}, ${googleAuthMode}, len=${googleKeyLength})`) : theme.muted(`(${googleAuthSource})`)}`,
  );
  runtime.log(
    `${theme.muted("Hooks internal:")} ${internalEnabled ? theme.success("enabled") : theme.warn("disabled")}`,
  );
  runtime.log(
    `${theme.muted("experiential-capture:")} ${experientialCfg?.enabled === true ? theme.success("enabled") : theme.warn("disabled")} ${theme.muted(`model=${evaluationModelRaw}`)}${configEvaluationModel && configEvaluationModel !== MERIDIA_DEFAULT_EVALUATION_MODEL ? theme.warn(` (config override ignored: ${configEvaluationModel})`) : ""}`,
  );
  runtime.log(
    `${theme.muted("compaction:")} ${compactionCfg?.enabled === true ? theme.success("enabled") : theme.warn("disabled")}`,
  );
  runtime.log(
    `${theme.muted("session-end:")} ${sessionEndCfg?.enabled === true ? theme.success("enabled") : theme.warn("disabled")}`,
  );

  const fixes: string[] = [];
  if (!internalEnabled) {
    fixes.push(`- ${report.fix.enableInternalHooks}`);
  }
  if (experientialCfg?.enabled !== true) {
    fixes.push(`- ${report.fix.enableExperientialCapture}`);
  }
  if (evaluationModelRaw !== MERIDIA_DEFAULT_EVALUATION_MODEL) {
    fixes.push(`- ${report.fix.setExperientialModel}`);
  }
  if (compactionCfg?.enabled !== true) {
    fixes.push(`- ${report.fix.enableCompaction}`);
  }
  if (sessionEndCfg?.enabled !== true) {
    fixes.push(`- ${report.fix.enableSessionEnd}`);
  }
  if (!googleAuthOk) {
    fixes.push(`- ${report.fix.configureGoogle}`);
  }
  if (fixes.length > 0) {
    runtime.log(`\n${theme.heading("Fix commands")}\n${fixes.join("\n")}`);
    runtime.log(theme.muted("\nRestart the gateway after config changes."));
  }
}
