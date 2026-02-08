import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import {
  formatBytes,
  readResourceSnapshot,
  type ResourceScope,
  type ResourceSnapshot,
} from "../../infra/system-resources.js";

type ResourceArgs = {
  scopes: ResourceScope[];
  includeTop: boolean;
};

function parseResourcesArgs(body: string): ResourceArgs {
  const raw = body.replace(/^\/resources\b/i, "").trim();
  const tokens = raw.split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const includeTop = tokens.includes("top") || tokens.includes("--top");
  const wantsHost = tokens.includes("host");
  const wantsContainer = tokens.includes("container");
  const wantsAll = tokens.includes("all") || (wantsHost && wantsContainer);
  if (wantsAll) {
    return { scopes: ["container", "host"], includeTop };
  }
  if (wantsHost) {
    return { scopes: ["host"], includeTop };
  }
  if (wantsContainer) {
    return { scopes: ["container"], includeTop };
  }
  return { scopes: ["container"], includeTop };
}

function formatLoadAvg(loadAvg?: [number, number, number]): string | undefined {
  if (!loadAvg) {
    return undefined;
  }
  return loadAvg.map((value) => value.toFixed(2)).join(" ");
}

function formatCpuLine(snapshot: ResourceSnapshot): string | undefined {
  const usage = snapshot.cpu?.usagePct;
  const load = formatLoadAvg(snapshot.cpu?.loadAvg);
  const parts: string[] = [];
  if (usage != null) {
    parts.push(`${Math.round(usage)}%`);
  }
  if (load) {
    parts.push(`load ${load}`);
  }
  if (snapshot.cpu?.cores) {
    parts.push(`${snapshot.cpu.cores} cores`);
  }
  return parts.length ? `CPU: ${parts.join(" · ")}` : undefined;
}

function formatMemoryLine(snapshot: ResourceSnapshot): string | undefined {
  if (!snapshot.memory) {
    return undefined;
  }
  const total = snapshot.memory.totalBytes;
  const used = snapshot.memory.usedBytes;
  const pct = total > 0 ? Math.round((used / total) * 100) : undefined;
  const parts = [`${formatBytes(used)}/${formatBytes(total)}`];
  if (pct != null) {
    parts.push(`${pct}%`);
  }
  if (snapshot.memory.availableBytes != null) {
    parts.push(`avail ${formatBytes(snapshot.memory.availableBytes)}`);
  }
  return `Memory: ${parts.join(" · ")}`;
}

function formatDiskLine(snapshot: ResourceSnapshot): string | undefined {
  if (!snapshot.disk) {
    return undefined;
  }
  const total = snapshot.disk.totalBytes;
  const used = snapshot.disk.usedBytes;
  const pct = total > 0 ? Math.round((used / total) * 100) : undefined;
  const parts = [`${formatBytes(used)}/${formatBytes(total)}`];
  if (pct != null) {
    parts.push(`${pct}%`);
  }
  parts.push(`free ${formatBytes(snapshot.disk.freeBytes)}`);
  return `Disk (${snapshot.disk.path}): ${parts.join(" · ")}`;
}

function formatTopProcesses(snapshot: ResourceSnapshot): string[] {
  if (!snapshot.topProcesses || snapshot.topProcesses.length === 0) {
    return [];
  }
  const lines = ["Top processes:"];
  snapshot.topProcesses.forEach((proc, index) => {
    lines.push(
      `${index + 1}) pid ${proc.pid} · ${proc.command} · ${proc.cpuPct.toFixed(1)}% CPU · ${proc.memPct.toFixed(1)}% MEM`,
    );
  });
  return lines;
}

function formatSnapshot(snapshot: ResourceSnapshot, showLabel: boolean): string[] {
  const lines: string[] = [];
  if (snapshot.error) {
    lines.push(showLabel ? `Host: ${snapshot.error}` : snapshot.error);
    return lines;
  }
  if (showLabel) {
    lines.push(snapshot.scope === "host" ? "Host:" : "Container:");
  }
  const cpu = formatCpuLine(snapshot);
  const memory = formatMemoryLine(snapshot);
  const disk = formatDiskLine(snapshot);
  if (cpu) {
    lines.push(cpu);
  }
  if (memory) {
    lines.push(memory);
  }
  if (disk) {
    lines.push(disk);
  }
  if (snapshot.warnings?.length) {
    for (const warning of snapshot.warnings) {
      lines.push(`Note: ${warning}`);
    }
  }
  lines.push(...formatTopProcesses(snapshot));
  return lines;
}

async function buildResourcesReply(commandBodyNormalized: string): Promise<ReplyPayload> {
  const { scopes, includeTop } = parseResourcesArgs(commandBodyNormalized);
  const snapshots = await Promise.all(
    scopes.map((scope) => readResourceSnapshot({ scope, includeTop })),
  );
  const multi = snapshots.length > 1;
  const lines = ["📊 Resources"];
  for (const snapshot of snapshots) {
    lines.push(...formatSnapshot(snapshot, multi));
    if (multi) {
      lines.push("");
    }
  }
  return { text: lines.filter(Boolean).join("\n").trim() };
}

export const handleResourcesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/resources" && !normalized.startsWith("/resources ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /resources from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const reply = await buildResourcesReply(normalized);
  return { shouldContinue: false, reply };
};
