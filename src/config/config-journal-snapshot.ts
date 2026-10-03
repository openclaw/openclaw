// Stores the fingerprinted config snapshot used by the config change journal.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import path from "node:path";
import { prepareSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  CONFIG_SNAPSHOT_SCOPE,
  CONFIG_SNAPSHOT_KEY,
  type ConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.kernel.js";
import { resolveStateDir } from "./paths.js";

const CONFIG_JOURNAL_FINGERPRINT_KEY_FILENAME = "config-journal-fingerprint.key";
const CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES = 32;
const CONFIG_JOURNAL_REDACTION_MARKER = "***";

type ConfigAuditStoreContext = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

type ResolvedConfigAuditStoreContext = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
};

type ConfigSnapshotWrite = ConfigAuditStoreContext & {
  configPath: string;
  rawHash: string;
  authoredConfig: unknown;
  expectedSnapshot?: ConfigSnapshotAuditRecord | null;
};

const configJournalFingerprintKeys = new Map<string, Buffer>();

function loadConfigJournalFingerprintKey(params?: ConfigAuditStoreContext): Buffer | null {
  const context = resolveConfigAuditStoreContext(params);
  const stateDir = resolveStateDir(context.env, context.homedir);
  const keyPath = path.join(stateDir, CONFIG_JOURNAL_FINGERPRINT_KEY_FILENAME);
  const cached = configJournalFingerprintKeys.get(keyPath);
  if (cached) {
    return cached;
  }
  try {
    let key: Buffer;
    try {
      key = fs.readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const created = randomBytes(CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES);
      try {
        const descriptor = fs.openSync(keyPath, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, created);
        } finally {
          fs.closeSync(descriptor);
        }
        key = created;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw createError;
        }
        key = fs.readFileSync(keyPath);
      }
    }
    if (key.length !== CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES) {
      return null;
    }
    fs.chmodSync(keyPath, 0o600);
    configJournalFingerprintKeys.set(keyPath, key);
    return key;
  } catch {
    return null;
  }
}

function fingerprintConfigSnapshotValue(value: unknown, key: Buffer | null): string {
  if (!key) {
    // Degrade to redaction when persistent key storage is unavailable; writes must still succeed.
    return CONFIG_JOURNAL_REDACTION_MARKER;
  }
  // JSON-encode every primitive (strings included) so "1" and 1 fingerprint
  // differently; a type-only edit must not read as an opaque change.
  const serialized = JSON.stringify(value);
  return `fp:${createHmac("sha256", key)
    .update(serialized ?? String(value))
    .digest("hex")
    .slice(0, 12)}`;
}

function fingerprintConfigSnapshotLeaves(value: unknown, key: Buffer | null): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => fingerprintConfigSnapshotLeaves(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([fieldKey, entry]) => [
        fieldKey,
        fingerprintConfigSnapshotLeaves(entry, key),
      ]),
    );
  }
  return fingerprintConfigSnapshotValue(value, key);
}

export function fingerprintConfigSnapshotAuthoredConfig(
  value: unknown,
  params?: ConfigAuditStoreContext,
): unknown {
  const key = loadConfigJournalFingerprintKey(params);
  // This slot is a diff baseline, not a data store; fingerprint every leaf.
  return fingerprintConfigSnapshotLeaves(structuredClone(value), key);
}

function resolveConfigAuditStoreContext(
  params?: ConfigAuditStoreContext,
): ResolvedConfigAuditStoreContext {
  return {
    env: params?.env ?? process.env,
    homedir: params?.homedir ?? defaultHomedir,
  };
}

export function resolveConfigAuditStoreEnv(
  params: ResolvedConfigAuditStoreContext,
): NodeJS.ProcessEnv {
  return {
    ...params.env,
    OPENCLAW_STATE_DIR: resolveStateDir(params.env, params.homedir),
  };
}

/** Single owner of the slot's path-identity convention (resolve-normalized). */
export function configSnapshotAuditRecordMatchesPath(
  snapshot: ConfigSnapshotAuditRecord | null,
  configPath: string,
): snapshot is ConfigSnapshotAuditRecord {
  return snapshot?.configPath === path.resolve(configPath);
}

function prepareConfigSnapshotAuditRecord(params: ConfigSnapshotWrite): ConfigSnapshotAuditRecord {
  return {
    configPath: path.resolve(params.configPath),
    rawHash: params.rawHash,
    fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(
      params.authoredConfig,
      params,
    ),
  };
}

export async function readLatestConfigSnapshotAuditRecordAsync(
  params?: ConfigAuditStoreContext,
  assertCurrent?: () => void,
): Promise<ConfigSnapshotAuditRecord | null> {
  assertCurrent?.();
  try {
    const env = resolveConfigAuditStoreEnv(resolveConfigAuditStoreContext(params));
    const context = captureOpenClawStateWorkerContext({ env });
    const result = await executeExistingOpenClawStateRead(
      { env },
      { type: "config.snapshot.read" },
      { context, current: true },
    );
    context.admission.assertCurrent();
    assertCurrent?.();
    return result?.ok && result.type === "config.snapshot.read" ? result.snapshot : null;
  } catch {
    assertCurrent?.();
    return null;
  }
}

export async function upsertConfigSnapshotAuditRecordAsync(
  params: ConfigSnapshotWrite,
  assertCurrent?: () => void,
): Promise<ConfigSnapshotAuditRecord | null> {
  assertCurrent?.();
  try {
    const snapshot = prepareConfigSnapshotAuditRecord(params);
    const written = await writeConfigSnapshotAuditRecord({ ...params, snapshot }, assertCurrent);
    return written ? snapshot : null;
  } catch {
    assertCurrent?.();
    return null;
  }
}

async function writeConfigSnapshotAuditRecord(
  params: ConfigAuditStoreContext & {
    snapshot: ConfigSnapshotAuditRecord | null;
    expectedSnapshot?: ConfigSnapshotAuditRecord | null;
  },
  assertCurrent?: () => void,
): Promise<boolean> {
  assertCurrent?.();
  try {
    const env = resolveConfigAuditStoreEnv(resolveConfigAuditStoreContext(params));
    const context = captureOpenClawStateWorkerContext({ env });
    const input = {
      record:
        params.snapshot === null
          ? null
          : prepareSqliteAuditRecord(CONFIG_SNAPSHOT_SCOPE, {
              key: CONFIG_SNAPSHOT_KEY,
              value: params.snapshot,
              createdAt: Date.now(),
            }),
      expectedPayloadJson:
        params.expectedSnapshot === null ? null : JSON.stringify(params.expectedSnapshot),
    };
    const written = await runOpenClawStateWorkerOperation(
      context,
      (store) => store.execute({ type: "config.snapshot.upsert", input }),
      { assertCurrent },
    );
    context.admission.assertCurrent();
    assertCurrent?.();
    return written;
  } catch {
    assertCurrent?.();
    return false;
  }
}

export async function restoreConfigSnapshotAuditRecordAsync(
  params: Parameters<typeof writeConfigSnapshotAuditRecord>[0],
  assertCurrent?: () => void,
): Promise<void> {
  await writeConfigSnapshotAuditRecord(params, assertCurrent);
}
