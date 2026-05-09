import fs from "node:fs/promises";
import path from "node:path";
import { saveCommitmentStore } from "../../../commitments/store.js";
import type { CommitmentRecord, CommitmentStoreFile } from "../../../commitments/types.js";
import { resolveStateDir } from "../../../config/paths.js";

const STORE_VERSION = 1 as const;
const LEGACY_COMMITMENT_STORE_RELATIVE_PATH = path.join("commitments", "commitments.json");

function defaultCommitmentStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), LEGACY_COMMITMENT_STORE_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceCommitment(raw: unknown): CommitmentRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  if (!dueWindow) {
    return undefined;
  }
  const requiredStrings = [
    raw.id,
    raw.agentId,
    raw.sessionKey,
    raw.channel,
    raw.kind,
    raw.sensitivity,
    raw.source,
    raw.status,
    raw.reason,
    raw.suggestedText,
    raw.dedupeKey,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  if (
    typeof raw.confidence !== "number" ||
    typeof raw.createdAtMs !== "number" ||
    typeof raw.updatedAtMs !== "number" ||
    typeof raw.attempts !== "number" ||
    typeof dueWindow.earliestMs !== "number" ||
    typeof dueWindow.latestMs !== "number" ||
    typeof dueWindow.timezone !== "string"
  ) {
    return undefined;
  }
  const commitment = { ...raw } as CommitmentRecord;
  delete commitment.sourceUserText;
  delete commitment.sourceAssistantText;
  return commitment;
}

function coerceCommitmentStore(parsed: unknown): CommitmentStoreFile {
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.commitments)) {
    return { version: STORE_VERSION, commitments: [] };
  }
  return {
    version: STORE_VERSION,
    commitments: parsed.commitments.flatMap((entry) => {
      const coerced = coerceCommitment(entry);
      return coerced ? [coerced] : [];
    }),
  };
}

export async function legacyCommitmentStoreFileExists(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await fs.access(defaultCommitmentStorePath(env));
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyCommitmentStoreFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ imported: boolean; commitments: number }> {
  const filePath = defaultCommitmentStorePath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, commitments: 0 };
    }
    throw err;
  }
  const store = coerceCommitmentStore(parsed);
  await saveCommitmentStore(store, { env });
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true, commitments: store.commitments.length };
}
