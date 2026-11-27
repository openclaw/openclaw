import fs from "node:fs";
import os from "node:os";
import { sql } from "kysely";
import { z } from "zod";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { isContainerEnvironment } from "./container-environment.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import { isTruthyEnvValue } from "./env.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveReadOnlyShmSqliteFileUri } from "./node-sqlite.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-boot-schema.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";

// Sidecar mtime is the cross-namespace heartbeat; payload bytes and ownership stay immutable.
export const GATEWAY_OWNER_HEARTBEAT_MS = 15_000;
export const GATEWAY_OWNER_HEARTBEAT_STALE_MS = 90_000;
export const LEGACY_GATEWAY_OWNER_LEASE_TTL_MS = 5 * 60_000;

const [uuidBoot, windowsBoot, freebsdBoot] = managedHandoffBootSchema.options;
const host = z.string().min(1);
export const MachineIdentitySchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const GatewayProcessNamespaceSchema = z.discriminatedUnion("platform", [
  uuidBoot.extend({ host, platform: z.literal("linux"), pidNsInode: z.string().min(1) }),
  uuidBoot.extend({ host, platform: z.literal("darwin") }),
  // Windows uses host-scoped PIDs and absolute process-start identity. Keep
  // accepting recorded boot timestamps, but do not require an unused CIM probe.
  windowsBoot.extend({ host, identity: windowsBoot.shape.identity.optional() }),
  freebsdBoot.extend({ host }),
]);
type ProcessNamespace = z.infer<typeof GatewayProcessNamespaceSchema>;
let processNamespace: { platform: NodeJS.Platform; value: ProcessNamespace | null } | undefined;

/** Cache OS subprocess failures too; only Linux's cheap /proc probes remain retryable. */
export function readGatewayLockProcessNamespace(): ProcessNamespace | null {
  if (
    processNamespace?.platform === process.platform &&
    (processNamespace.value !== null ||
      (process.platform !== "linux" && process.platform !== "android"))
  ) {
    return processNamespace.value;
  }
  try {
    const boot =
      process.platform === "win32"
        ? { platform: "win32" as const }
        : createManagedHandoffBootIdentityReader(process.env)();
    const value = GatewayProcessNamespaceSchema.parse({
      host: os.hostname(),
      ...boot,
      ...(boot.platform === "linux"
        ? {
            // PRoot can read this magic link but cannot follow its synthetic target with stat.
            pidNsInode: fs.readlinkSync("/proc/self/ns/pid").match(/^pid:\[(\d+)\]$/u)?.[1],
          }
        : {}),
    });
    processNamespace = { platform: process.platform, value };
    return value;
  } catch {
    processNamespace = { platform: process.platform, value: null };
    return null;
  }
}

type GatewayLockHolder = Partial<Pick<LockPayload, "pid" | "processNamespace">> & {
  host?: string;
  heartbeatAt?: number;
  ownerId?: unknown;
  role?: unknown;
  createdAt?: unknown;
  expiresAt?: number | null;
};

function isLegacyGatewayLeaseLock(holder: {
  processNamespace?: unknown;
  role?: unknown;
  ownerId?: unknown;
  createdAt?: unknown;
}): holder is { role: "gateway"; ownerId: string; createdAt: string } {
  // 9.7 introduced explicit Gateway-role process owners; 9.6 projections omit the role.
  return (
    process.platform === "linux" &&
    !isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF) &&
    holder.processNamespace === undefined &&
    holder.role === "gateway" &&
    typeof holder.ownerId === "string" &&
    holder.ownerId.length > 0 &&
    typeof holder.createdAt === "string"
  );
}

function readLockHeartbeat(lockPath: string): number | undefined {
  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function isForeignLinuxNamespace(
  owner: ProcessNamespace | undefined | null,
  current: ProcessNamespace | null,
) {
  return (
    owner?.platform === "linux" &&
    current?.platform === "linux" &&
    (owner.host !== current.host || owner.pidNsInode !== current.pidNsInode)
  );
}

/** Diagnostic facts never grant ownership; callers still classify the recorded holder. */
export function describeGatewayLockHolder(
  holder: GatewayLockHolder,
  lockPath?: string,
  localState?: "live" | "unknown",
) {
  const namespace = GatewayProcessNamespaceSchema.safeParse(holder.processNamespace).data;
  const heartbeatAt = (lockPath ? readLockHeartbeat(lockPath) : undefined) ?? holder.heartbeatAt;
  const ageMs = heartbeatAt === undefined ? undefined : Date.now() - heartbeatAt;
  const location = `${namespace?.host ?? holder.host ?? "unknown host"}${namespace?.platform === "linux" ? `/pid-ns ${namespace.pidNsInode}` : ""}`;
  const action =
    localState === "live"
      ? `The holder ${holder.pid} is alive on this host, stop it first`
      : localState === "unknown"
        ? "Stop the holder before retrying"
        : "Run this command inside the Gateway container or with a shared PID namespace";
  return `holder ${holder.pid ?? "unknown"} at ${location}, last renewed ${ageMs === undefined ? "at an unknown time" : `${Math.max(0, Math.floor(ageMs / 1000))} s ago`}. ${action}.`;
}

export class GatewayLockNamespaceError extends Error {
  readonly heartbeatAgeMs?: number;
  readonly legacyLock: boolean;
  readonly legacyLease: boolean;

  constructor(holder: GatewayLockHolder, lockPath?: string) {
    const legacyLock = process.platform === "linux" && holder.processNamespace === undefined;
    super(
      `cannot verify Gateway ownership from this process${lockPath ? ` at ${lockPath}` : ""}. ${
        legacyLock
          ? `Legacy holder ${holder.pid ?? "unknown"} has no PID namespace evidence. It may already have stopped. Independently verify that no Gateway using this state is running on this host or in any sharing container. With a current OpenClaw CLI using the same state and profile, run \`openclaw gateway recover-lock --json\`, then \`openclaw gateway recover-lock --confirm <confirmation> --json\` with the returned confirmation. Retry Doctor afterward.`
          : describeGatewayLockHolder(holder, lockPath)
      }`,
    );
    this.name = "GatewayLockNamespaceError";
    this.legacyLock = legacyLock;
    this.legacyLease =
      isLegacyGatewayLeaseLock(holder) ||
      (legacyLock &&
        !isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF) &&
        typeof holder.expiresAt === "number");
    const owner = GatewayProcessNamespaceSchema.safeParse(holder.processNamespace).data;
    if (isForeignLinuxNamespace(owner, readGatewayLockProcessNamespace())) {
      const heartbeatAt = lockPath ? readLockHeartbeat(lockPath) : holder.heartbeatAt;
      if (heartbeatAt !== undefined) {
        this.heartbeatAgeMs = Math.max(0, Date.now() - heartbeatAt);
      }
    }
  }
}

/**
 * File-lock recovery also covers pre-namespace (before 2026.10.1) records from supported
 * upgrades on hosts whose PIDs are kernel-global. Linux legacy Gateways use their DB lease.
 */
export function classifyGatewayLockProcessNamespace(
  holder:
    | {
        processNamespace?: unknown;
        machineIdentity?: unknown;
        pid?: unknown;
        startTime?: unknown;
        ownerId?: unknown;
        role?: unknown;
        createdAt?: unknown;
      }
    | null
    | undefined,
  lockPath?: string,
  databasePath?: string,
): "same" | "dead" | "unknown" {
  if (holder && databasePath && isLegacyGatewayLeaseLock(holder)) {
    const now = Date.now();
    const createdAt = Date.parse(holder.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt <= LEGACY_GATEWAY_OWNER_LEASE_TTL_MS) {
      return "unknown";
    }
    try {
      // This lock primitive must inspect the selected DB before it can obtain maintenance.
      // Read the live WAL without changing its SHM; legacy files never renew their mtime.
      const db = openNodeSqliteDatabase(resolveReadOnlyShmSqliteFileUri(databasePath), {
        readOnly: true,
      });
      try {
        const stateDb = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
        const { rows } = executeSqliteQuerySync(db, {
          compile: () =>
            /* kysely-allow-raw: lock recovery must not trust a damaged lease lookup index. */
            sql<{ expiresAt: number | null }>`SELECT expires_at AS expiresAt
              FROM ${sql`state_leases NOT INDEXED`}
              WHERE scope = ${"gateway-owner"} AND owner = ${holder.ownerId}`.compile(stateDb),
        });
        return rows.every((row) => typeof row.expiresAt === "number" && row.expiresAt <= now)
          ? "dead"
          : "unknown";
      } finally {
        db.close();
      }
    } catch {
      // Missing/unreadable databases, old schemas and PostgreSQL anchors prove nothing.
      return "unknown";
    }
  }
  if (
    (process.platform === "win32" || process.platform === "darwin") &&
    holder &&
    holder.processNamespace === undefined &&
    lockPath
  ) {
    try {
      // A missing namespace never grants local authority. Only an expired heartbeat
      // plus native proof of process death can retire this legacy file owner.
      if (
        Date.now() - fs.statSync(lockPath).mtimeMs > GATEWAY_OWNER_HEARTBEAT_STALE_MS &&
        isLockOwnerDefinitelyStale({ payload: { pid: holder.pid, starttime: holder.startTime } })
      ) {
        return "dead";
      }
    } catch {
      // Unavailable heartbeat or process observations preserve the owner.
    }
    return "unknown";
  }
  return classifyGatewayOwnerProcessNamespace(holder?.processNamespace, {
    machineIdentity: holder?.machineIdentity,
    readGatewayHeartbeat: lockPath ? () => readLockHeartbeat(lockPath) : undefined,
  });
}

/** File locks and SQLite leases require comparable evidence of process death. */
export function classifyGatewayOwnerProcessNamespace(
  value: unknown,
  options: {
    ownerHost?: string;
    machineIdentity?: unknown;
    readGatewayHeartbeat?: () => number | undefined;
  } = {},
): "same" | "dead" | "unknown" {
  const owner = GatewayProcessNamespaceSchema.safeParse(value).data;
  if (!owner || (options.ownerHost !== undefined && options.ownerHost !== owner.host)) {
    return "unknown";
  }
  const current = readGatewayLockProcessNamespace();
  if (!current) {
    return "unknown";
  }
  if (owner.platform !== current.platform) {
    return "unknown";
  }
  if (
    options.readGatewayHeartbeat &&
    owner.platform === "linux" &&
    current.platform === "linux" &&
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF) &&
    (owner.identity !== current.identity || isForeignLinuxNamespace(owner, current))
  ) {
    return "unknown";
  }
  if (options.readGatewayHeartbeat && isForeignLinuxNamespace(owner, current)) {
    // Docker and Podman default to a container ID hostname, already stored in the record.
    if (
      owner.host === current.host &&
      /^[a-f0-9]{12}$/u.test(current.host) &&
      isContainerEnvironment()
    ) {
      return "dead";
    }
    // A container paused for over 90s can resume alongside its replacement until its
    // next restart. We don't add fencing; native SQLite locking still protects the file.
    const heartbeatAt = options.readGatewayHeartbeat();
    if (heartbeatAt !== undefined && Date.now() - heartbeatAt > GATEWAY_OWNER_HEARTBEAT_STALE_MS) {
      return "dead";
    }
  }
  if (owner.platform === "darwin" && options.machineIdentity !== undefined) {
    const machine = MachineIdentitySchema.safeParse(options.machineIdentity).data;
    const currentMachine = readProcessMachineIdentity();
    if (machine && currentMachine) {
      if (machine !== currentMachine) {
        return "unknown";
      }
      // A reboot ends every process on this Mac, even if its hostname changed.
      if (owner.identity !== current.identity) {
        return "dead";
      }
    }
  }
  // macOS hostnames can change within one boot; the kernel UUID still binds
  // PID inspection to that same kernel. Legacy records with a different host and boot stay unknown.
  const sameDarwinBoot =
    owner.platform === "darwin" &&
    current.platform === "darwin" &&
    owner.identity === current.identity;
  if (owner.host !== current.host && !sameDarwinBoot) {
    return "unknown";
  }
  // Windows boot observations can disagree within one boot. Local Windows owners
  // use PID and absolute process-start identity; heartbeat age cannot revoke them.
  if (owner.platform === "win32") {
    return "same";
  }
  if (owner.identity !== current.identity) {
    return "dead";
  }
  if (
    owner.platform !== "linux" ||
    (current.platform === "linux" && owner.pidNsInode === current.pidNsInode)
  ) {
    return "same";
  }
  return "unknown";
}

export const LockPayloadSchema = z.object({
  pid: z.number(),
  ownerId: z.string().min(1).optional(),
  /** A cold opener may wait for this transient owner, never enter while it is held. */
  stateOwnerKind: z.literal("schema").optional(),
  /** Present when Gateway cron writes use the dynamic-default ownership projection. */
  cronOwnerProjection: z.literal("dynamic-default-v1").optional(),
  createdAt: z.string(),
  startupPhase: z.literal("starting").optional(),
  configPath: z.string(),
  port: z.number().int().min(1).max(65_535).optional(),
  role: z
    .enum(["gateway", "agent-embedded", "skill-workshop-apply", "sqlite-maintenance"])
    .optional(),
  stateDir: z.string().optional(),
  startTime: z.number().optional(),
  parentPid: z.number().int().positive().optional(),
  parentStartTime: z.number().optional(),
  // Null and absent identities cannot establish the owner's process namespace.
  processNamespace: GatewayProcessNamespaceSchema.nullable().optional(),
  // Keep the Linux PID 1 start time outside the namespace object for older strict readers.
  pidNsInitStartTicks: z.number().int().nonnegative().optional(),
  // Shipped readers ignore this sibling; the nested namespace must remain rollback-compatible.
  machineIdentity: MachineIdentitySchema.nullable().optional(),
});

export type LockPayload = z.infer<typeof LockPayloadSchema>;
export type GatewayLockIdentity = {
  pid: number;
  ownerId?: string;
  cronOwnerProjection?: "dynamic-default-v1";
  createdAt: string;
  port: number;
  startTime?: number;
};

export function isSameGatewayLockIdentity(
  previous: GatewayLockIdentity,
  current: GatewayLockIdentity,
): boolean {
  if (previous.ownerId && current.ownerId) {
    return previous.ownerId === current.ownerId;
  }
  return (
    previous.pid === current.pid &&
    previous.createdAt === current.createdAt &&
    previous.startTime === current.startTime
  );
}

export type GatewayLockRole = NonNullable<LockPayload["role"]>;

/** Parent loss cancels maintenance; peers still wait for its native process to exit. */
export function isGatewayMaintenanceParentStale(owner: LockPayload | null): boolean {
  return (
    owner?.role === "sqlite-maintenance" &&
    owner.parentPid !== undefined &&
    ((owner.pid === process.pid && process.ppid !== owner.parentPid) ||
      isLockOwnerDefinitelyStale({
        payload: { pid: owner.parentPid, starttime: owner.parentStartTime },
      }))
  );
}

export function parseGatewayLockPayload(raw: string): LockPayload | null {
  return safeParseJsonWithSchema(LockPayloadSchema, raw);
}
