import fs from "node:fs";
import os from "node:os";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

// Sidecar mtime is the cross-namespace heartbeat; payload bytes and ownership stay immutable.
// Owners renew every 15 seconds and forfeit foreign-namespace custody after 90 seconds.
export const GATEWAY_OWNER_HEARTBEAT_MS = 15_000;
export const GATEWAY_OWNER_HEARTBEAT_STALE_MS = 90_000;

const [uuidBoot, windowsBoot, freebsdBoot] = managedHandoffBootSchema.options;
const host = z.string().min(1);
export const GatewayProcessNamespaceSchema = z.discriminatedUnion("platform", [
  uuidBoot.extend({ host, platform: z.literal("linux"), pidNsInode: z.string().min(1) }),
  uuidBoot.extend({ host, platform: z.literal("darwin") }),
  windowsBoot.extend({ host }),
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
    const boot = createManagedHandoffBootIdentityReader(process.env)();
    const value = GatewayProcessNamespaceSchema.parse({
      host: os.hostname(),
      ...boot,
      ...(boot.platform === "linux"
        ? { pidNsInode: fs.statSync("/proc/self/ns/pid", { bigint: true }).ino.toString() }
        : {}),
    });
    processNamespace = { platform: value.platform, value };
    return value;
  } catch {
    processNamespace = { platform: process.platform, value: null };
    return null;
  }
}

export class GatewayLockNamespaceError extends Error {
  constructor() {
    super(
      "cannot verify Gateway ownership from this process (different PID namespace); the owner heartbeat is fresh — run this command inside the Gateway container or with a shared PID namespace. If the previous Gateway stopped, wait up to 90 seconds after its last heartbeat, then retry",
    );
    this.name = "GatewayLockNamespaceError";
  }
}

/** Qualify PID evidence before any local process probe or same-PID authority shortcut. */
export function classifyGatewayLockProcessNamespace(
  value: unknown,
  lockPath?: string,
): "same" | "dead" | "unknown" {
  return classifyGatewayOwnerProcessNamespace(value, {
    readHeartbeatAt: () => (lockPath ? fs.statSync(lockPath).mtimeMs : undefined),
  });
}

/** File locks and SQLite leases share one boot/namespace and heartbeat policy. */
export function classifyGatewayOwnerProcessNamespace(
  value: unknown,
  options: { readHeartbeatAt?: () => number | undefined; ownerHost?: string } = {},
): "same" | "dead" | "unknown" {
  // Legacy local records or comparable boot/namespace identity: existing PID rules.
  // Different boot on the same host: dead.
  // Foreign/unreadable namespace: heartbeat >90s old => dead; otherwise unknown/preserve.
  const owner = GatewayProcessNamespaceSchema.safeParse(value).data;
  const ownerHost = owner?.host ?? options.ownerHost;
  const foreignHost = ownerHost !== undefined && ownerHost !== os.hostname();
  if (value === undefined && !foreignHost) {
    return "same";
  }
  const current = readGatewayLockProcessNamespace();
  if (owner && current) {
    if (
      owner.platform === current.platform &&
      owner.host === current.host &&
      owner.identity !== current.identity
    ) {
      return "dead";
    }
    if (
      owner.platform === current.platform &&
      owner.identity === current.identity &&
      (owner.platform !== "linux" ||
        (current.platform === "linux" && owner.pidNsInode === current.pidNsInode))
    ) {
      return "same";
    }
  } else if (process.platform !== "linux" && !foreignHost) {
    return "same";
  }
  try {
    const heartbeatAt = options.readHeartbeatAt?.();
    return heartbeatAt !== undefined && Date.now() - heartbeatAt > GATEWAY_OWNER_HEARTBEAT_STALE_MS
      ? "dead"
      : "unknown";
  } catch {
    return "unknown";
  }
}

const LockPayloadSchema = z.object({
  pid: z.number(),
  ownerId: z.string().min(1).optional(),
  /** A cold opener may wait for this transient owner, never enter while it is held. */
  stateOwnerKind: z.literal("schema").optional(),
  /** Present when Gateway cron writes use the dynamic-default ownership projection. */
  cronOwnerProjection: z.literal("dynamic-default-v1").optional(),
  createdAt: z.string(),
  configPath: z.string(),
  port: z.number().int().min(1).max(65_535).optional(),
  role: z
    .enum(["gateway", "agent-embedded", "skill-workshop-apply", "sqlite-maintenance"])
    .optional(),
  stateDir: z.string().optional(),
  startTime: z.number().optional(),
  // Null records an unavailable identity; absent fields retain legacy PID recovery.
  processNamespace: GatewayProcessNamespaceSchema.nullable().optional(),
});

export type LockPayload = z.infer<typeof LockPayloadSchema>;
export type GatewayLockRole = NonNullable<LockPayload["role"]>;

export function parseGatewayLockPayload(raw: string): LockPayload | null {
  return safeParseJsonWithSchema(LockPayloadSchema, raw);
}
