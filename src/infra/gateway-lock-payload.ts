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

const ProcessNamespaceSchema = z.object({
  host: z.string().min(1),
  boot: managedHandoffBootSchema,
  pidNamespace: z.string().min(1),
});
type ProcessNamespace = z.infer<typeof ProcessNamespaceSchema>;
let processNamespace: ProcessNamespace | undefined;

/** Successful identity is stable for this process; unavailable probes remain retryable. */
export function readGatewayLockProcessNamespace(): ProcessNamespace | null {
  if (processNamespace?.boot.platform === process.platform) {
    return processNamespace;
  }
  try {
    const boot = createManagedHandoffBootIdentityReader(process.env)();
    processNamespace = {
      host: os.hostname(),
      boot,
      pidNamespace:
        process.platform === "linux"
          ? fs.statSync("/proc/self/ns/pid", { bigint: true }).ino.toString()
          : "host",
    };
    return processNamespace;
  } catch {
    return null;
  }
}

export class GatewayLockNamespaceError extends Error {
  constructor() {
    super(
      "cannot verify Gateway ownership from this process (different PID namespace); the owner heartbeat is fresh — run this command inside the Gateway container or with a shared PID namespace",
    );
    this.name = "GatewayLockNamespaceError";
  }
}

/** Qualify PID evidence before any local process probe or same-PID authority shortcut. */
export function classifyGatewayLockProcessNamespace(
  value: unknown,
  lockPath?: string,
): "same" | "dead" | "unknown" {
  // Legacy records retain their same-namespace PID recovery contract.
  if (value === undefined) {
    return "same";
  }
  const recorded = ProcessNamespaceSchema.safeParse(value);
  const current = readGatewayLockProcessNamespace();
  if (recorded.success && current && recorded.data.boot.platform === current.boot.platform) {
    if (recorded.data.boot.identity !== current.boot.identity) {
      if (recorded.data.host === current.host) {
        return "dead";
      }
    } else if (recorded.data.pidNamespace === current.pidNamespace) {
      return "same";
    }
  }
  if (lockPath) {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > GATEWAY_OWNER_HEARTBEAT_STALE_MS) {
        return "dead";
      }
    } catch {
      // An unreadable heartbeat cannot establish that its owner stopped renewing.
    }
  }
  return "unknown";
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
  // Null records an unavailable probe; only absent fields use legacy PID recovery.
  processNamespace: ProcessNamespaceSchema.nullable().optional(),
});

export type LockPayload = z.infer<typeof LockPayloadSchema>;
export type GatewayLockRole = NonNullable<LockPayload["role"]>;

export function parseGatewayLockPayload(raw: string): LockPayload | null {
  return safeParseJsonWithSchema(LockPayloadSchema, raw);
}
