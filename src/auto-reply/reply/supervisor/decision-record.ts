import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose } from "../../../globals.js";
import { SUPERVISOR_TAXONOMY_VERSION } from "./taxonomy.js";
import type { SupervisorDecisionRecord } from "./types.js";

export function buildSupervisorDecisionRecord(
  params: Omit<SupervisorDecisionRecord, "id" | "timestamp" | "taxonomyVersion">,
): SupervisorDecisionRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    taxonomyVersion: SUPERVISOR_TAXONOMY_VERSION,
    ...params,
  };
}

export function resolveSupervisorDecisionRecordPath(sessionFile: string): string {
  const sessionDir = path.dirname(sessionFile);
  const agentDir = path.dirname(sessionDir);
  const sessionId = path.basename(sessionFile, ".jsonl");
  return path.join(agentDir, "supervisor-decisions", `${sessionId}.jsonl`);
}

export async function appendSupervisorDecisionRecord(params: {
  sessionFile: string;
  record: SupervisorDecisionRecord;
}): Promise<void> {
  const filePath = resolveSupervisorDecisionRecordPath(params.sessionFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(params.record)}\n`, "utf-8");
  logVerbose(`supervisor: recorded decision ${params.record.action} -> ${filePath}`);
}

export async function readLatestSupervisorDecisionRecord(
  sessionFile: string,
): Promise<SupervisorDecisionRecord | undefined> {
  try {
    const filePath = resolveSupervisorDecisionRecordPath(sessionFile);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const lastLine = lines.at(-1);
    if (!lastLine) {
      return undefined;
    }
    return JSON.parse(lastLine) as SupervisorDecisionRecord;
  } catch {
    return undefined;
  }
}
