import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose } from "../../../globals.js";
import { SUPERVISOR_TAXONOMY_VERSION } from "./taxonomy.js";
import type { SupervisorDecisionOutcomeRecord } from "./types.js";

export function buildSupervisorDecisionOutcomeRecord(
  params: Omit<SupervisorDecisionOutcomeRecord, "id" | "timestamp" | "taxonomyVersion">,
): SupervisorDecisionOutcomeRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    taxonomyVersion: SUPERVISOR_TAXONOMY_VERSION,
    ...params,
  } as SupervisorDecisionOutcomeRecord;
}

export function resolveSupervisorOutcomeRecordPath(sessionFile: string): string {
  const sessionDir = path.dirname(sessionFile);
  const agentDir = path.dirname(sessionDir);
  const sessionId = path.basename(sessionFile, ".jsonl");
  return path.join(agentDir, "supervisor-outcomes", `${sessionId}.jsonl`);
}

export async function appendSupervisorDecisionOutcomeRecord(params: {
  sessionFile: string;
  record: SupervisorDecisionOutcomeRecord;
}): Promise<void> {
  const filePath = resolveSupervisorOutcomeRecordPath(params.sessionFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(params.record)}\n`, "utf-8");
  logVerbose(`supervisor: recorded outcome ${params.record.signal} -> ${filePath}`);
}

export async function readSupervisorDecisionOutcomeRecords(
  sessionFile: string,
): Promise<SupervisorDecisionOutcomeRecord[]> {
  try {
    const filePath = resolveSupervisorOutcomeRecordPath(sessionFile);
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SupervisorDecisionOutcomeRecord);
  } catch {
    return [];
  }
}
