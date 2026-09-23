import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
// Persists short-lived gateway restart intent for supervisor SIGTERM handoff.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { gatewayServiceCommandMatchesRoot } from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { readGatewayServiceUpdateOriginalRoot } from "../daemon/service-update-authority.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { readLockPayloadSync, resolveGatewayLockPaths } from "./gateway-lock.js";
import { readGatewayOwnerLease, readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { GatewayRestartPreparationError } from "./restart-intent-error.js";
import { spawnPsSync } from "./spawn-ps.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import { tryAcquireGatewayLifecycleCleanupCoordinator } from "./state-database-coordinator.js";

const GATEWAY_RESTART_INTENT_KEY = "gateway-restart";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;
const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "gateway_restart_intent", {
  errorMessage: "Gateway restart intent schema markers are missing",
});

const restartLog = createSubsystemLogger("restart");
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

type GatewayRestartIntentPayload = {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

type GatewayRestartIntentWriteReceipt = {
  kind: string;
  pid: number;
  created_at: number;
  reason: string | null;
  force: number | null;
  wait_ms: number | null;
  updated_at_ms: number;
};

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
  // Only the in-process deferral owner can attest that the drain budget was spent.
  drainBudgetExhausted?: true;
  // Process-local only: persisted restart requests cannot delegate successor ownership.
  successorOwner?: {
    kind: "managed-update-handoff";
    handoffId: string;
    installRoot: string;
  };
};

export function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
  onRecorded?: (clear: () => void) => void;
}): boolean {
  const targetPid = asPositiveSafeInteger(opts.targetPid) ?? null;
  if (targetPid === null) {
    return false;
  }
  return writeGatewayRestartIntentForTargetSync(opts, () => targetPid);
}

export type GatewayRestartIntentService = {
  kind: "systemd" | "launchd";
  name: string;
};

export type GatewayRestartIntentLegacyProcess = { pid: number; startTime: number };

/** Prepare installation/native-process evidence; lock identity is resolved again at write admission. */
export async function prepareGatewayRestartIntentLegacyProcess(opts: {
  env: NodeJS.ProcessEnv;
  command: GatewayServiceCommandConfig;
  runtimePid?: number;
  readRuntime: () => Promise<GatewayServiceRuntime>;
  assertCurrent: () => void;
}): Promise<GatewayRestartIntentLegacyProcess | undefined> {
  opts.assertCurrent();
  try {
    if (
      readGatewayOwnerLease({ env: opts.env, current: true }) !== undefined ||
      !existsSync(resolveGatewayLockPaths(opts.env).stateLockPath)
    ) {
      return undefined;
    }
    const pid = asPositiveSafeInteger(opts.runtimePid);
    if (pid === undefined || !isPidAlive(pid)) {
      return undefined;
    }
    const startTime = getFileLockProcessStartTime(pid, opts.env);
    if (startTime === null) {
      return undefined;
    }
    const roots = [
      await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url }),
      readGatewayServiceUpdateOriginalRoot(),
    ].filter((root): root is string => Boolean(root));
    const ownership = await Promise.all(
      roots.map((root) => gatewayServiceCommandMatchesRoot(root, opts.command)),
    );
    opts.assertCurrent();
    if (!ownership.includes(true)) {
      return undefined;
    }
    const runtime = await opts.readRuntime();
    if (
      runtime.status !== "running" ||
      runtime.pid !== pid ||
      !isPidAlive(pid) ||
      getFileLockProcessStartTime(pid, opts.env) !== startTime
    ) {
      return undefined;
    }
    return { pid, startTime };
  } catch {
    // Missing legacy evidence remains a typed serving-owner refusal at admission.
    return undefined;
  } finally {
    opts.assertCurrent();
  }
}

function isLegacyProcessInService(pid: number, mainPid: number): boolean {
  if (pid === mainPid) {
    return true;
  }
  const snapshot = spawnPsSync(["-e", "-o", "pid=", "-o", "ppid="], 1000);
  if (snapshot.error || snapshot.status !== 0) {
    return false;
  }
  const parents = new Map<number, number>();
  for (const line of snapshot.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) {
      parents.set(Number(match[1]), Number(match[2]));
    }
  }
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 0 && !seen.has(current)) {
    if (current === mainPid) {
      return true;
    }
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

// v2026.9.4 publishes gateway.state.lock without a SQLite owner lease. Remove this
// compatibility reader when 2026.9.4 leaves the supported upgrade window.
function readLegacyGatewayRestartLockSync(env: NodeJS.ProcessEnv) {
  const paths = resolveGatewayLockPaths(env);
  const payload = readLockPayloadSync(paths.stateLockPath, true);
  if (!payload) {
    return undefined;
  }
  const pid = asPositiveSafeInteger(payload.pid);
  if (
    pid === undefined ||
    !payload.ownerId ||
    !payload.port ||
    (payload.role !== undefined && payload.role !== "gateway") ||
    typeof payload.startTime !== "number" ||
    !Number.isSafeInteger(payload.startTime) ||
    payload.startTime < 0 ||
    !payload.stateDir ||
    resolveIdentityPathViaExistingAncestorSync(payload.stateDir) !== paths.stateDir ||
    resolveIdentityPathViaExistingAncestorSync(payload.configPath) !==
      resolveIdentityPathViaExistingAncestorSync(paths.configPath)
  ) {
    throw new GatewayRestartPreparationError("serving-owner");
  }
  return { payload, pid, startTime: payload.startTime, lockPath: paths.stateLockPath };
}

/** Called only for stopped native service state while physical cleanup exclusion is held. */
function assertLegacyGatewayStoppedSync(env: NodeJS.ProcessEnv) {
  const legacy = readLegacyGatewayRestartLockSync(env);
  if (!legacy) {
    return;
  }
  const knownDead = () => {
    if (isPidDefinitelyDead(legacy.pid)) {
      return true;
    }
    const startedAt = getFileLockProcessStartTime(legacy.pid, env);
    return startedAt !== null && startedAt !== legacy.startTime;
  };
  if (
    !knownDead() ||
    !isDeepStrictEqual(legacy.payload, readLockPayloadSync(legacy.lockPath, true)) ||
    !knownDead()
  ) {
    throw new GatewayRestartPreparationError("serving-owner");
  }
  // The successor owns stale-file reclamation; this check only proves absence of that owner.
}

function readLegacyGatewayRestartTargetSync(opts: {
  env?: NodeJS.ProcessEnv;
  legacyProcess?: GatewayRestartIntentLegacyProcess;
}): number | undefined {
  const env = opts.env ?? process.env;
  const legacy = readLegacyGatewayRestartLockSync(env);
  if (!legacy) {
    return undefined;
  }
  const native = opts.legacyProcess;
  if (!native) {
    throw new GatewayRestartPreparationError("serving-owner");
  }
  const { payload, pid, startTime, lockPath } = legacy;
  const stillCurrent = () =>
    isPidAlive(pid) &&
    getFileLockProcessStartTime(pid, env) === startTime &&
    isPidAlive(native.pid) &&
    getFileLockProcessStartTime(native.pid, env) === native.startTime;
  if (
    !stillCurrent() ||
    !isLegacyProcessInService(pid, native.pid) ||
    !isDeepStrictEqual(payload, readLockPayloadSync(lockPath, true)) ||
    !stillCurrent()
  ) {
    throw new GatewayRestartPreparationError("serving-owner");
  }
  return pid;
}

/** Native service control keeps its selected service; resolve its serving process at admission. */
export function writeGatewayServiceRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  service: GatewayRestartIntentService;
  nativeStopped: boolean;
  nativePid?: number;
  legacyProcess?: GatewayRestartIntentLegacyProcess;
  intent?: GatewayRestartIntent;
  reason?: string;
  assertCurrent: () => void;
  onRecorded?: (clear: () => void) => void;
}): boolean {
  if (opts.nativeStopped) {
    try {
      // A stopped wrapper can still have a serving child or an unpublished startup owner.
      const exclusion = tryAcquireGatewayLifecycleCleanupCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(opts.env),
      });
      if (exclusion) {
        try {
          const owner = readGatewayOwnerLease({ env: opts.env, current: true });
          opts.assertCurrent();
          if (!owner || owner.state === "dead") {
            assertLegacyGatewayStoppedSync(opts.env ?? process.env);
            opts.assertCurrent();
            return false;
          }
        } finally {
          // The successor must be able to acquire its lifecycle coordinator during startup.
          exclusion.release();
        }
      }
    } catch {
      opts.assertCurrent();
      throw new GatewayRestartPreparationError("serving-owner");
    }
  }
  const written = writeGatewayRestartIntentForTargetSync(
    opts,
    (db) => {
      try {
        const owner = readGatewayOwnerLeaseFromDatabase(db);
        if (owner === undefined) {
          const legacyPid = readLegacyGatewayRestartTargetSync(opts);
          if (legacyPid !== undefined) {
            return legacyPid;
          }
        }
        const supervisor = owner?.supervisor;
        if (
          owner?.state === "live" &&
          (opts.nativePid === undefined || isLegacyProcessInService(owner.pid, opts.nativePid)) &&
          owner.mode === "supervised" &&
          supervisor?.kind === opts.service.kind &&
          supervisor.name !== null &&
          (supervisor.kind === "systemd"
            ? resolveSystemdServiceName({ OPENCLAW_SYSTEMD_UNIT: supervisor.name }) ===
              resolveSystemdServiceName({ OPENCLAW_SYSTEMD_UNIT: opts.service.name })
            : supervisor.name === opts.service.name)
        ) {
          return owner.pid;
        }
      } catch {
        throw new GatewayRestartPreparationError("serving-owner");
      }
      throw new GatewayRestartPreparationError("serving-owner");
    },
    opts.assertCurrent,
  );
  if (!written) {
    throw new GatewayRestartPreparationError("intent-recording");
  }
  return written;
}

function writeGatewayRestartIntentForTargetSync(
  opts: {
    env?: NodeJS.ProcessEnv;
    intent?: GatewayRestartIntent;
    reason?: string;
    onRecorded?: (clear: () => void) => void;
  },
  resolveTargetPid: (db: DatabaseSync) => number | undefined,
  assertCurrent?: () => void,
): boolean {
  const env = opts.env ?? process.env;
  try {
    if (!existsSync(resolveOpenClawStateSqlitePath(env))) {
      restartLog.info("skipped gateway restart intent: no existing state database");
      return false;
    }
    const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
    const waitMs =
      typeof opts.intent?.waitMs === "number" &&
      Number.isFinite(opts.intent.waitMs) &&
      opts.intent.waitMs >= 0
        ? Math.floor(opts.intent.waitMs)
        : null;
    // The old Gateway still owns the schema until the restart hands off.
    let owned: GatewayRestartIntentWriteReceipt | undefined;
    const written = runExistingOpenClawStateWriteTransaction(
      ({ db }) => {
        // Coordinator/BEGIN admission can block while the supervised owner changes.
        assertCurrent?.();
        const targetPid = asPositiveSafeInteger(resolveTargetPid(db)) ?? null;
        assertCurrent?.();
        if (targetPid === null) {
          return false;
        }
        const createdAt = Date.now();
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        const previous = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("gateway_restart_intent")
            .select("updated_at_ms")
            .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
        );
        // Two writes in the same millisecond must still have distinct cleanup ownership.
        const generation = Math.max(createdAt, (previous?.updated_at_ms ?? 0) + 1);
        const row = {
          kind: "gateway-restart",
          pid: targetPid,
          created_at: createdAt,
          reason: reason ?? null,
          force: opts.intent?.force ? 1 : null,
          wait_ms: waitMs,
          updated_at_ms: generation,
        };
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_intent")
            .values({ intent_key: GATEWAY_RESTART_INTENT_KEY, ...row })
            .onConflict((conflict) => conflict.column("intent_key").doUpdateSet(row)),
        );
        owned = row;
        return true;
      },
      { env },
      { schemaSql: schema, operationLabel: "gateway.restart-intent.write" },
    );
    if (written && owned) {
      const receipt = owned;
      opts.onRecorded?.(() => clearGatewayRestartIntentSync(env, receipt));
    }
    return written;
  } catch (err) {
    // Revoked native control authority must not become a best-effort storage warning.
    assertCurrent?.();
    if (err instanceof GatewayRestartPreparationError) {
      throw err;
    }
    restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
    return false;
  }
}

export function clearGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  owned?: GatewayRestartIntentWriteReceipt,
): void {
  try {
    runExistingOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        let removal = stateDb
          .deleteFrom("gateway_restart_intent")
          .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY);
        if (owned) {
          // Published writers do not increment same-millisecond timestamps. Compare
          // their complete payload too, so their successor request remains theirs.
          removal = removal
            .where("kind", "=", owned.kind)
            .where("pid", "=", owned.pid)
            .where("created_at", "=", owned.created_at)
            .where("reason", owned.reason === null ? "is" : "=", owned.reason)
            .where("force", owned.force === null ? "is" : "=", owned.force)
            .where("wait_ms", owned.wait_ms === null ? "is" : "=", owned.wait_ms)
            .where("updated_at_ms", "=", owned.updated_at_ms);
        }
        executeSqliteQuerySync(db, removal);
      },
      { env },
      { schemaSql: schema, operationLabel: "gateway.restart-intent.clear" },
    );
  } catch {}
}

function readGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv,
): GatewayRestartIntentPayload | null {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
    const parsed = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_intent")
        .select(["kind", "pid", "created_at", "reason", "force", "wait_ms"])
        .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
    );
    if (
      parsed?.kind === "gateway-restart" &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.created_at === "number" &&
      Number.isFinite(parsed.created_at) &&
      (parsed.reason === null || typeof parsed.reason === "string") &&
      (parsed.force === null ||
        (typeof parsed.force === "number" && Number.isFinite(parsed.force))) &&
      (parsed.wait_ms === null ||
        (typeof parsed.wait_ms === "number" &&
          Number.isFinite(parsed.wait_ms) &&
          parsed.wait_ms >= 0))
    ) {
      const reason = normalizeRestartIntentReason(parsed.reason ?? undefined);
      return {
        kind: "gateway-restart",
        pid: parsed.pid,
        createdAt: parsed.created_at,
        ...(reason ? { reason } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(typeof parsed.wait_ms === "number" ? { waitMs: Math.floor(parsed.wait_ms) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function consumeGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartIntent | null {
  const payload = readGatewayRestartIntentPayloadSync(env);
  clearGatewayRestartIntentSync(env);
  if (!payload) {
    return null;
  }
  if (payload.pid !== process.pid) {
    return null;
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return null;
  }
  return {
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.force ? { force: true } : {}),
    ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
  };
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
}
