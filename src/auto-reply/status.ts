import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL } from "../agents/defaults.js";
import {
  derivePromptTokens,
  normalizeUsage,
  type UsageLike,
} from "../agents/usage.js";
import type { ClawdisConfig } from "../config/config.js";
import type { SessionEntry, SessionScope } from "../config/sessions.js";
import type { ThinkLevel, VerboseLevel } from "./thinking.js";

type ReplyConfig = NonNullable<ClawdisConfig["inbound"]>["reply"];

type StatusArgs = {
  reply: ReplyConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  resolvedThink?: ThinkLevel;
  resolvedVerbose?: VerboseLevel;
  now?: number;
  webLinked?: boolean;
  webAuthAgeMs?: number | null;
  heartbeatSeconds?: number;
};

type AgentProbe = {
  ok: boolean;
  detail: string;
  label: string;
};

const formatAge = (ms?: number | null) => {
  if (!ms || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const abbreviatePath = (p?: string) => {
  if (!p) return undefined;
  const home = os.homedir();
  if (p.startsWith(home)) return p.replace(home, "~");
  return p;
};

const probeAgentCommand = (command?: string[]): AgentProbe => {
  const bin = command?.[0];
  if (!bin) {
    return { ok: false, detail: "no command configured", label: "not set" };
  }

  const commandLabel = command
    .slice(0, 3)
    .map((c) => c.replace(/\{\{[^}]+}}/g, "{…}"))
    .join(" ")
    .concat(command.length > 3 ? " …" : "");

  const looksLikePath = bin.includes("/") || bin.startsWith(".");
  if (looksLikePath) {
    const exists = fs.existsSync(bin);
    return {
      ok: exists,
      detail: exists ? "binary found" : "binary missing",
      label: commandLabel || bin,
    };
  }

  try {
    const res = spawnSync("which", [bin], {
      encoding: "utf-8",
      timeout: 1500,
    });
    const found =
      res.status === 0 && res.stdout ? res.stdout.split("\n")[0]?.trim() : "";
    return {
      ok: Boolean(found),
      detail: found || "not in PATH",
      label: commandLabel || bin,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `probe failed: ${String(err)}`,
      label: commandLabel || bin,
    };
  }
};

const formatTokens = (
  total: number | null | undefined,
  contextTokens: number | null,
) => {
  const ctx = contextTokens ?? null;
  if (total == null) {
    const ctxLabel = ctx ? formatKTokens(ctx) : "?";
    return `unknown/${ctxLabel}`;
  }
  const pct = ctx ? Math.min(999, Math.round((total / ctx) * 100)) : null;
  const totalLabel = formatKTokens(total);
  const ctxLabel = ctx ? formatKTokens(ctx) : "?";
  return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};

const readUsageFromSessionLog = (
  sessionId?: string,
  storePath?: string,
):
  | {
      input: number;
      output: number;
      promptTokens: number;
      total: number;
      model?: string;
    }
  | undefined => {
  // Prefer the coding-agent session log (pi-mono) if present.
  // Path resolution rules (priority):
  // 1) Store directory sibling file <sessionId>.jsonl
  // 2) PI coding agent dir: ~/.pi/agent/sessions/<sessionId>.jsonl
  if (!sessionId) return undefined;

  const candidatePaths: string[] = [];

  if (storePath) {
    const dir = path.dirname(storePath);
    candidatePaths.push(path.join(dir, `${sessionId}.jsonl`));
  }

  const piDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  candidatePaths.push(path.join(piDir, `${sessionId}.jsonl`));

  const logPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!logPath) return undefined;

  try {
    const lines = fs.readFileSync(logPath, "utf-8").split(/\n+/);
    let input = 0;
    let output = 0;
    let promptTokens = 0;
    let model: string | undefined;
    let lastUsage: ReturnType<typeof normalizeUsage> | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          message?: {
            usage?: UsageLike;
            model?: string;
          };
          usage?: UsageLike;
          model?: string;
        };
        const usageRaw = parsed.message?.usage ?? parsed.usage;
        const usage = normalizeUsage(usageRaw);
        if (usage) lastUsage = usage;
        model = parsed.message?.model ?? parsed.model ?? model;
      } catch {
        // ignore bad lines
      }
    }

    if (!lastUsage) return undefined;
    input = lastUsage.input ?? 0;
    output = lastUsage.output ?? 0;
    promptTokens =
      derivePromptTokens(lastUsage) ?? lastUsage.total ?? input + output;
    const total = lastUsage.total ?? promptTokens + output;
    if (promptTokens === 0 && total === 0) return undefined;
    return { input, output, promptTokens, total, model };
  } catch {
    return undefined;
  }
};

export function buildStatusMessage(args: StatusArgs): string {
  const now = args.now ?? Date.now();
  const entry = args.sessionEntry;
  let model = entry?.model ?? args.reply?.agent?.model ?? DEFAULT_MODEL;
  let contextTokens =
    entry?.contextTokens ??
    args.reply?.agent?.contextTokens ??
    lookupContextTokens(model) ??
    DEFAULT_CONTEXT_TOKENS;

  let totalTokens =
    entry?.totalTokens ??
    (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);

  // Prefer prompt-size tokens from the session transcript when it looks larger
  // (cached prompt tokens are often missing from agent meta/store).
  const logUsage = readUsageFromSessionLog(entry?.sessionId, args.storePath);
  if (logUsage) {
    const candidate = logUsage.promptTokens || logUsage.total;
    if (!totalTokens || totalTokens === 0 || candidate > totalTokens) {
      totalTokens = candidate;
    }
    if (!model) model = logUsage.model ?? model;
    if (!contextTokens && logUsage.model) {
      contextTokens = lookupContextTokens(logUsage.model) ?? contextTokens;
    }
  }
  const agentProbe = probeAgentCommand(args.reply?.command);

  const thinkLevel =
    args.resolvedThink ?? args.reply?.thinkingDefault ?? "auto";
  const verboseLevel =
    args.resolvedVerbose ?? args.reply?.verboseDefault ?? "off";

  const webLine = (() => {
    if (args.webLinked === false) {
      return "Web: not linked — run `clawdis login` to scan the QR.";
    }
    const authAge = formatAge(args.webAuthAgeMs);
    const heartbeat =
      typeof args.heartbeatSeconds === "number"
        ? ` • heartbeat ${args.heartbeatSeconds}s`
        : "";
    return `Web: linked • auth refreshed ${authAge}${heartbeat}`;
  })();

  const sessionLine = [
    `Session: ${args.sessionKey ?? "unknown"}`,
    `scope ${args.sessionScope ?? "per-sender"}`,
    entry?.updatedAt
      ? `updated ${formatAge(now - entry.updatedAt)}`
      : "no activity",
    args.storePath ? `store ${abbreviatePath(args.storePath)}` : undefined,
  ]
    .filter(Boolean)
    .join(" • ");

  const contextLine = `Context: ${formatTokens(
    totalTokens,
    contextTokens ?? null,
  )}${entry?.abortedLastRun ? " • last run aborted" : ""}`;

  const optionsLine = `Options: thinking=${thinkLevel} | verbose=${verboseLevel} (set with /think <level>, /verbose on|off)`;

  const agentLine = `Agent: ${agentProbe.ok ? "ready" : "check"} — ${agentProbe.label}${agentProbe.detail ? ` (${agentProbe.detail})` : ""}${model ? ` • model ${model}` : ""}`;

  const helpersLine = "Shortcuts: /new reset | /restart relink";

  return [
    "⚙️ Status",
    webLine,
    agentLine,
    contextLine,
    sessionLine,
    optionsLine,
    helpersLine,
  ].join("\n");
}
