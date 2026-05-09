import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ACP_EVENT_LEDGER_VERSION,
  normalizeAcpEventLedgerSnapshot,
  writeAcpEventLedgerSnapshotToSqlite,
} from "../../../acp/event-ledger.js";
import { resolveStateDir } from "../../../config/paths.js";

export function resolveLegacyAcpEventLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "acp", "event-ledger.json");
}

export function legacyAcpEventLedgerFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return statSync(resolveLegacyAcpEventLedgerPath(env)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isLegacyAcpEventLedgerShape(raw: unknown): raw is {
  version: typeof ACP_EVENT_LEDGER_VERSION;
  sessions: Record<string, unknown>;
} {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as { version?: unknown }).version === ACP_EVENT_LEDGER_VERSION &&
    typeof (raw as { sessions?: unknown }).sessions === "object" &&
    (raw as { sessions?: unknown }).sessions !== null &&
    !Array.isArray((raw as { sessions?: unknown }).sessions)
  );
}

export async function importLegacyAcpEventLedgerFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ imported: boolean; sessions: number; events: number }> {
  const filePath = resolveLegacyAcpEventLedgerPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { imported: false, sessions: 0, events: 0 };
    }
    throw error;
  }
  if (!isLegacyAcpEventLedgerShape(parsed)) {
    return { imported: false, sessions: 0, events: 0 };
  }
  const store = normalizeAcpEventLedgerSnapshot(parsed);
  writeAcpEventLedgerSnapshotToSqlite(store, { env });
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return {
    imported: true,
    sessions: Object.keys(store.sessions).length,
    events: Object.values(store.sessions).reduce(
      (count, session) => count + session.events.length,
      0,
    ),
  };
}
