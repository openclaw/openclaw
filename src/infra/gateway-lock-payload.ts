import fs from "node:fs";
import os from "node:os";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

// Sidecar mtime is the cross-namespace heartbeat; payload bytes and ownership stay immutable.
// Renewal age is diagnostic only: a paused or unreachable owner may still be alive.
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
    (processNamespace.value !== null || process.platform !== "linux")
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
    processNamespace = { platform: value.platform, value };
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

/** Diagnostic facts never grant ownership; callers still classify the recorded holder. */
export function describeGatewayLockHolder(
  holder: GatewayLockHolder,
  lockPath?: string,
  localState?: "live" | "unknown",
) {
  const namespace = GatewayProcessNamespaceSchema.safeParse(holder.processNamespace).data;
  let heartbeatAt = holder.heartbeatAt;
  if (lockPath) {
    try {
      heartbeatAt = fs.statSync(lockPath).mtimeMs;
    } catch {
      // Preserve the refusal when the heartbeat cannot be inspected.
    }
  }
  const ageMs = heartbeatAt === undefined ? undefined : Date.now() - heartbeatAt;
  const location = `${namespace?.host ?? holder.host ?? "unknown host"}${namespace?.platform === "linux" ? `/pid-ns ${namespace.pidNsInode}` : ""}`;
  const action =
    localState === "live"
      ? `The holder ${holder.pid} is alive on this host, stop it first`
      : localState === "unknown"
        ? "Stop the holder before retrying; if it has already stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner"
        : "Run this command inside the Gateway container or with a shared PID namespace; if the holder has stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner";
  return `holder ${holder.pid ?? "unknown"} at ${location}, last renewed ${ageMs === undefined ? "at an unknown time" : `${Math.max(0, Math.floor(ageMs / 1000))} s ago`}. ${action}.`;
}

export class GatewayLockNamespaceError extends Error {
  constructor(holder: GatewayLockHolder, lockPath?: string) {
    super(
      `cannot verify Gateway ownership from this process; heartbeat age does not prove that the holder stopped. ${describeGatewayLockHolder(holder, lockPath)}`,
    );
    this.name = "GatewayLockNamespaceError";
  }
}

/** File-lock recovery also covers pre-namespace Windows records from supported upgrades. */
export function classifyGatewayLockProcessNamespace(
  holder:
    | { processNamespace?: unknown; machineIdentity?: unknown; pid?: unknown; startTime?: unknown }
    | null
    | undefined,
  lockPath?: string,
): "same" | "dead" | "unknown" {
  if (process.platform === "win32" && holder && holder.processNamespace === undefined && lockPath) {
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
  });
}

/** File locks and SQLite leases require comparable evidence of process death. */
export function classifyGatewayOwnerProcessNamespace(
  value: unknown,
  options: { ownerHost?: string; machineIdentity?: unknown } = {},
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
