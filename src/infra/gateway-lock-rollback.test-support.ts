import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

// Frozen from v2026.10.7. Do not import current schemas: this proves rollback parsing.
const managedHandoffBootSchema = z.union([
  z.strictObject({
    platform: z.enum(["linux", "darwin"]),
    identity: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  }),
  z.strictObject({
    platform: z.literal("win32"),
    identity: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/),
  }),
  z.strictObject({
    platform: z.literal("freebsd"),
    identity: z.string().regex(/^[a-f0-9]{32}$/),
  }),
]);
const [uuidBoot, windowsBoot, freebsdBoot] = managedHandoffBootSchema.options;
const hostSchema = z.string().min(1);
const GatewayProcessNamespaceSchema = z.discriminatedUnion("platform", [
  uuidBoot.extend({
    host: hostSchema,
    platform: z.literal("linux"),
    pidNsInode: z.string().min(1),
  }),
  uuidBoot.extend({ host: hostSchema, platform: z.literal("darwin") }),
  windowsBoot.extend({ host: hostSchema }),
  freebsdBoot.extend({ host: hostSchema }),
]);
export const shippedLockPayloadSchema = z.object({
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
  // Null records an unavailable identity; absent fields retain legacy PID recovery.
  processNamespace: GatewayProcessNamespaceSchema.nullable().optional(),
});

type StateLeaseProcessOwner = {
  pid: number;
  host: string;
  startedAt: number | null;
  processNamespace?: z.infer<typeof GatewayProcessNamespaceSchema> | null;
};
export function parseShippedStateLeaseProcessOwner(
  payloadJson: string | null,
): StateLeaseProcessOwner | null {
  const owner = safeParseJsonRecord(payloadJson ?? "")?.owner;
  if (!isRecord(owner)) {
    return null;
  }
  const { pid, host, startedAt } = owner;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    !host ||
    (startedAt !== null &&
      (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0))
  ) {
    return null;
  }
  return {
    pid,
    host,
    startedAt,
    ...(owner.processNamespace === undefined
      ? {}
      : {
          processNamespace:
            GatewayProcessNamespaceSchema.safeParse(owner.processNamespace).data ?? null,
        }),
  };
}
