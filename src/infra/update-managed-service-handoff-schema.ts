import path from "node:path";
import { z } from "zod";

const text = z.string().min(1).max(4096);
const processIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  startIdentity: text.max(128),
});
export const managedHandoffBootSchema = z.union([
  z.strictObject({
    platform: z.enum(["linux", "darwin"]),
    identity: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  }),
  z.strictObject({
    platform: z.literal("win32"),
    identity: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/),
  }),
]);
const nativeLifetimeSchema = z.strictObject({
  kind: z.literal("native"),
  unit: text,
  scope: text,
  placement: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({
      kind: z.literal("attached"),
      invocation: z.string().regex(/^[a-f0-9]{32}$/i),
    }),
  ]),
});
const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("update") }),
  z
    .strictObject({
      kind: z.literal("triage"),
      phase: z.enum(["reserved", "running", "closing", "closed", "uncertain"]),
      lifetime: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("foreground"), boot: managedHandoffBootSchema }),
        nativeLifetimeSchema,
      ]),
    })
    .refine(
      (action) =>
        action.phase !== "running" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind === "attached",
    ),
]);
const sourcePath = text.refine(path.isAbsolute, "Native source path must be absolute");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeBorrowerSourceSchema = z.strictObject({
  runId: text,
  transactionId: text,
  claimId: text,
  revision: z.number().int().nonnegative(),
  recordSha256: digest,
  serviceKey: sourcePath,
  configPaths: z.array(sourcePath).min(1).max(512),
  lifetimeId: text,
});
const nativeBorrowerSchema = z.strictObject({
  id: z.string().uuid(),
  phase: z.enum(["reserved", "admitted"]),
  source: nativeBorrowerSourceSchema,
});
const commonPayload = {
  executor: processIdentitySchema,
  helper: processIdentitySchema,
  action: actionSchema,
};
// Preserve v3 decoding solely to refuse retained custody. No current producer
// creates or upgrades these records, and process death never reclaims them.
const payloadSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(2), ...commonPayload }),
  z.strictObject({
    version: z.literal(3),
    ...commonPayload,
    action: z.strictObject({ kind: z.literal("update") }),
    nativeBorrower: nativeBorrowerSchema,
  }),
]);

export type HandoffProcessIdentity = z.infer<typeof processIdentitySchema>;
export type HandoffNativeLifetime = z.infer<typeof nativeLifetimeSchema>;
export type ManagedHandoffLeaseAction = z.infer<typeof actionSchema>;
export type ManagedHandoffLeasePayload = z.infer<typeof payloadSchema>;

export function parseManagedHandoffLeasePayload(value: string) {
  try {
    return payloadSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
