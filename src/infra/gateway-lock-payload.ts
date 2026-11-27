import fs from "node:fs";
import os from "node:os";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { isContainerEnvironment } from "./container-environment.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import { isTruthyEnvValue } from "./env.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-boot-schema.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";

// Sidecar mtime is the cross-namespace heartbeat; payload bytes and ownership stay immutable.
export const GATEWAY_OWNER_HEARTBEAT_MS = 15_000;
export const GATEWAY_OWNER_HEARTBEAT_STALE_MS = 90_000;

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
};

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

  constructor(holder: GatewayLockHolder, lockPath?: string) {
    super(
      `cannot verify Gateway ownership from this process${lockPath ? ` at ${lockPath}` : ""}. ${describeGatewayLockHolder(holder, lockPath)}`,
    );
    this.name = "GatewayLockNamespaceError";
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
 * upgrades on hosts whose PIDs are kernel-global. Linux PID namespaces keep them unknown.
 */
export function classifyGatewayLockProcessNamespace(
  holder:
    | { processNamespace?: unknown; machineIdentity?: unknown; pid?: unknown; startTime?: unknown }
    | null
    | undefined,
  lockPath?: string,
): "same" | "dead" | "unknown" {
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
