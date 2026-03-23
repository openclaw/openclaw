import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withFileLock } from "../../plugin-sdk/file-lock.js";
import { writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import { resolveConfigDir } from "../../utils.js";
import { redactEvent } from "./redaction.js";
import { ResearchEventV1Schema, type ResearchEventV1 } from "./types.js";

const log = createSubsystemLogger("research/events");
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export type ResearchPolicy = {
  enabled: boolean;
  ttlDays: number;
  maxBytes: number;
  redactionMode: "default";
};

export type ResearchArtifactStats = {
  root: string;
  fileCount: number;
  totalBytes: number;
  lastWriteTimeMs: number | null;
};

type CleanupStats = {
  ttlDeletedFiles: number;
  ttlDeletedBytes: number;
  capDeletedFiles: number;
  capDeletedBytes: number;
  warnings: string[];
};

type WriterState = {
  enabled: boolean;
  emit: (event: ResearchEventV1) => Promise<void>;
  close: () => Promise<void>;
};

function resolveResearchRoot(): string {
  return path.join(resolveConfigDir(), "research", "events");
}

export function isResearchEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.research?.enabled === true;
}

export function getResearchPolicy(cfg?: OpenClawConfig): ResearchPolicy {
  const ttlDaysEnv = Number.parseInt(process.env.OPENCLAW_RESEARCH_TTL_DAYS ?? "", 10);
  const maxBytesEnv = Number.parseInt(process.env.OPENCLAW_RESEARCH_MAX_BYTES ?? "", 10);
  return {
    enabled: isResearchEnabled(cfg),
    ttlDays: Number.isFinite(ttlDaysEnv) && ttlDaysEnv > 0 ? ttlDaysEnv : DEFAULT_RETENTION_DAYS,
    maxBytes: Number.isFinite(maxBytesEnv) && maxBytesEnv > 0 ? maxBytesEnv : DEFAULT_MAX_BYTES,
    redactionMode: "default",
  };
}

async function listEventFiles(root: string): Promise<Array<{ filePath: string; stat: Stats }>> {
  const out: Array<{ filePath: string; stat: Stats }> = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".events.jsonl")) {
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) {
        continue;
      }
      out.push({ filePath: full, stat });
    }
  };
  await walk(root);
  return out;
}

async function cleanupArtifacts(
  root: string,
  policy: ResearchPolicy,
): Promise<{ stats: ResearchArtifactStats; cleanup: CleanupStats }> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const files = await listEventFiles(root);
  const now = Date.now();
  const ttlMs = policy.ttlDays * 24 * 60 * 60 * 1000;
  const cleanup: CleanupStats = {
    ttlDeletedFiles: 0,
    ttlDeletedBytes: 0,
    capDeletedFiles: 0,
    capDeletedBytes: 0,
    warnings: [],
  };

  // TTL cleanup (best-effort, never throws).
  for (const file of files) {
    if (now - file.stat.mtimeMs <= ttlMs) {
      continue;
    }
    try {
      await fs.rm(file.filePath, { force: true });
      cleanup.ttlDeletedFiles += 1;
      cleanup.ttlDeletedBytes += file.stat.size;
    } catch (err) {
      cleanup.warnings.push(String(err));
    }
  }

  const remaining = await listEventFiles(root);
  const sortedOldestFirst = remaining.toSorted((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let totalBytes = sortedOldestFirst.reduce((sum, file) => sum + file.stat.size, 0);
  if (totalBytes > policy.maxBytes) {
    for (const file of sortedOldestFirst) {
      if (totalBytes <= policy.maxBytes) {
        break;
      }
      try {
        await fs.rm(file.filePath, { force: true });
        cleanup.capDeletedFiles += 1;
        cleanup.capDeletedBytes += file.stat.size;
        totalBytes -= file.stat.size;
      } catch (err) {
        cleanup.warnings.push(String(err));
      }
    }
  }

  const finalFiles = await listEventFiles(root);
  const lastWriteTimeMs =
    finalFiles.length > 0 ? Math.max(...finalFiles.map((entry) => entry.stat.mtimeMs)) : null;
  const stats: ResearchArtifactStats = {
    root,
    fileCount: finalFiles.length,
    totalBytes: finalFiles.reduce((sum, file) => sum + file.stat.size, 0),
    lastWriteTimeMs,
  };
  return { stats, cleanup };
}

async function writeGovernanceSnapshot(params: {
  root: string;
  policy: ResearchPolicy;
  stats: ResearchArtifactStats;
  cleanup: CleanupStats;
}): Promise<void> {
  const policyPath = path.join(params.root, "policy.json");
  await withFileLock(
    policyPath,
    { retries: { retries: 3, factor: 1.5, minTimeout: 20, maxTimeout: 200 }, stale: 10_000 },
    async () => {
      await writeJsonFileAtomically(policyPath, {
        policy: params.policy,
        stats: params.stats,
        cleanup: params.cleanup,
        updatedAt: new Date().toISOString(),
      });
    },
  ).catch(() => undefined);
}

export async function getResearchArtifactStats(cfg?: OpenClawConfig): Promise<{
  policy: ResearchPolicy;
  stats: ResearchArtifactStats;
}> {
  const policy = getResearchPolicy(cfg);
  const root = resolveResearchRoot();
  const { stats } = await cleanupArtifacts(root, policy);
  return { policy, stats };
}

export function createEventsWriter(params: {
  cfg?: OpenClawConfig;
  runId: string;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}): WriterState {
  const policy = getResearchPolicy(params.cfg);
  if (!policy.enabled) {
    return {
      enabled: false,
      emit: async () => {},
      close: async () => {},
    };
  }

  const root = resolveResearchRoot();
  const runDir = path.join(root, params.agentId);
  const filePath = path.join(runDir, `${params.sessionId}.events.jsonl`);
  let disabled = false;
  let queue = Promise.resolve();
  let flushedGovernance = false;

  const writeOne = async (event: ResearchEventV1) => {
    if (disabled) {
      return;
    }
    try {
      const parsed = ResearchEventV1Schema.parse(event);
      const redacted = redactEvent(parsed);
      const line = `${JSON.stringify(redacted)}\n`;
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      if (!flushedGovernance) {
        flushedGovernance = true;
        const { stats, cleanup } = await cleanupArtifacts(root, policy);
        await writeGovernanceSnapshot({ root, policy, stats, cleanup });
      }
    } catch (err) {
      disabled = true;
      log.warn(`research events disabled after write failure: ${String(err)}`);
    }
  };

  return {
    enabled: true,
    emit: async (event) => {
      queue = queue.then(() => writeOne(event)).catch(() => undefined);
      await queue;
    },
    close: async () => {
      await queue;
    },
  };
}
