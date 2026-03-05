import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "gateway.err.log");

// [iris-tokens] turn in=X out=Y [cacheRead=Z] [cacheWrite=W] [cost=$N] | session total=T
const TOKEN_RE =
  /^\[iris-tokens\] turn in=(\d+) out=(\d+)(?:\s+cacheRead=(\d+))?(?:\s+cacheWrite=(\d+))?(?:\s+cost=\$([0-9.]+))?/;

// [iris-compress] before=Xch after=Ych saved=Zch (~Ntok, P%)
const COMPRESS_RE = /^\[iris-compress\].*?saved=(\d+)ch.*?~(\d+)tok.*?(\d+)%/;

// ISO timestamp prefix: 2026-02-24T11:45:46.832Z
const DATE_RE = /^(\d{4}-\d{2}-\d{2})T/;

type DayStats = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  compressSavedTok: number;
  compressPctSum: number;
  compressCount: number;
};

function emptyDay(): DayStats {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    compressSavedTok: 0,
    compressPctSum: 0,
    compressCount: 0,
  };
}

async function parseIrisLog(days: number): Promise<Map<string, DayStats>> {
  let raw: string;
  try {
    raw = await fs.readFile(LOG_PATH, "utf-8");
  } catch {
    return new Map();
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  const byDay = new Map<string, DayStats>();
  let currentDate = "";

  for (const line of raw.split("\n")) {
    // Track latest date from any timestamped log line
    const dateMatch = line.match(DATE_RE);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }

    if (!currentDate || currentDate < cutoffDate) {
      continue;
    }

    const tokenMatch = line.match(TOKEN_RE);
    if (tokenMatch) {
      const day = byDay.get(currentDate) ?? emptyDay();
      day.turns++;
      day.input += parseInt(tokenMatch[1], 10);
      day.output += parseInt(tokenMatch[2], 10);
      day.cacheRead += tokenMatch[3] ? parseInt(tokenMatch[3], 10) : 0;
      day.cacheWrite += tokenMatch[4] ? parseInt(tokenMatch[4], 10) : 0;
      day.cost += tokenMatch[5] ? parseFloat(tokenMatch[5]) : 0;
      byDay.set(currentDate, day);
      continue;
    }

    const compressMatch = line.match(COMPRESS_RE);
    if (compressMatch) {
      const day = byDay.get(currentDate) ?? emptyDay();
      day.compressSavedTok += parseInt(compressMatch[2], 10);
      day.compressPctSum += parseInt(compressMatch[3], 10);
      day.compressCount++;
      byDay.set(currentDate, day);
    }
  }

  return byDay;
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function formatStats(byDay: Map<string, DayStats>): string {
  if (byDay.size === 0) {
    return "📊 No iris-tokens data found in gateway log.";
  }

  const sorted = [...byDay.entries()].toSorted((a, b) => b[0].localeCompare(a[0]));

  const lines: string[] = ["📊 Iris token stats (last 7 days)\n"];

  let totalTurns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCache = 0;
  let totalCost = 0;
  let totalSavedTok = 0;
  let totalCompressCount = 0;
  let totalPctSum = 0;

  for (const [date, d] of sorted) {
    const cache = d.cacheRead + d.cacheWrite;
    const cacheStr = cache > 0 ? ` cache=${formatK(cache)}` : "";
    const costStr = d.cost > 0 ? ` $${d.cost.toFixed(2)}` : "";
    const compressStr =
      d.compressCount > 0 ? ` compress=${Math.round(d.compressPctSum / d.compressCount)}%` : "";
    lines.push(
      `${date}: ${d.turns}t in=${formatK(d.input)} out=${formatK(d.output)}${cacheStr}${costStr}${compressStr}`,
    );

    totalTurns += d.turns;
    totalInput += d.input;
    totalOutput += d.output;
    totalCache += cache;
    totalCost += d.cost;
    totalSavedTok += d.compressSavedTok;
    totalCompressCount += d.compressCount;
    totalPctSum += d.compressPctSum;
  }

  const totCacheStr = totalCache > 0 ? ` cache=${formatK(totalCache)}` : "";
  const totCompressStr =
    totalCompressCount > 0
      ? ` compress=${Math.round(totalPctSum / totalCompressCount)}% saved~${formatK(totalSavedTok)}tok`
      : "";
  lines.push("");
  lines.push(
    `Total: ${totalTurns}t in=${formatK(totalInput)} out=${formatK(totalOutput)}${totCacheStr} $${totalCost.toFixed(2)}${totCompressStr}`,
  );

  return lines.join("\n");
}

export const handleStatsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/stats" && !normalized.startsWith("/stats ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /stats from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  try {
    const byDay = await parseIrisLog(7);
    const text = formatStats(byDay);
    return { shouldContinue: false, reply: { text } };
  } catch (err) {
    return { shouldContinue: false, reply: { text: `❌ /stats error: ${String(err)}` } };
  }
};
