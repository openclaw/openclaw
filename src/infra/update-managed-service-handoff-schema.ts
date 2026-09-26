import path from "node:path";
import { z } from "zod";

const text = z.string().min(1).max(4096);
const nativeProcessIdentityShape = {
  pid: z.number().int().positive(),
  startIdentity: text.max(128),
};
const processIdentitySchema = z
  .strictObject({
    ...nativeProcessIdentityShape,
    // Older strict readers must not mistake an argv digest for a dead process.
    startIdentitySource: z.literal("argv-sha256").nullable().optional(),
  })
  .refine(({ startIdentity, startIdentitySource }) =>
    startIdentitySource === "argv-sha256"
      ? /^win32-argv-sha256:[a-f0-9]{64}$/.test(startIdentity)
      : !startIdentity.startsWith("win32-argv-sha256:"),
  );
export const managedHandoffBootSchema = z.union([
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
// Direct original owners and their descendants require cancellation-aware
// admission. Strict older readers reject this marker before running a callback.
const cancellationProtocol = z.literal("original-cancellation-v1");
const cancellableUpdateAction = z.strictObject({
  kind: z.literal("update"),
  mutationProtocol: cancellationProtocol,
});
const updateAction = cancellableUpdateAction.extend({
  mutationProtocol: cancellationProtocol.optional(),
});
const actionSchema = z.discriminatedUnion("kind", [
  updateAction,
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
// Cancellation preserves the original v2 bytes for admitted-child lineage. It is
// deliberately a distinct version: older readers and helper release receipts
// must retain custody, never interpret this as an ordinary update lease.
const originalUpdateSchema = z.strictObject({
  version: z.literal(2),
  executor: processIdentitySchema,
  helper: processIdentitySchema,
  action: updateAction,
});
const originalGenerationSchema = z.strictObject({
  key: text,
  owner: text,
  payload: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
const cancellingPayloadSchema = z
  .strictObject({
    version: z.literal(4),
    executor: processIdentitySchema,
    helper: processIdentitySchema,
    action: updateAction,
    cancellation: originalGenerationSchema,
  })
  .refine((value) => {
    try {
      const original = originalUpdateSchema.parse(JSON.parse(value.cancellation.payload));
      return (
        JSON.stringify(original.helper) === JSON.stringify(value.helper) &&
        JSON.stringify(original.executor) === JSON.stringify(value.executor) &&
        JSON.stringify(original.action) === JSON.stringify(value.action) &&
        (JSON.stringify(value.helper) === JSON.stringify(value.executor) ||
          original.action.mutationProtocol === "original-cancellation-v1")
      );
    } catch {
      return false;
    }
  });

// Candidate package roots retain a non-recursive reference to the original
// generation even after their child aliases have settled. Strict old readers
// reject the extra field; it is not independent mutation or cancellation authority.
const currentPayloadSchema = z
  .strictObject({
    version: z.literal(2),
    ...commonPayload,
    mutationOriginal: originalGenerationSchema.optional(),
  })
  .refine((value) => {
    if (!value.mutationOriginal) {
      return true;
    }
    try {
      const original = originalUpdateSchema.parse(JSON.parse(value.mutationOriginal.payload));
      return (
        !value.mutationOriginal.key.includes("/.openclaw-update-child-") &&
        original.action.mutationProtocol === "original-cancellation-v1"
      );
    } catch {
      return false;
    }
  });

// Preserve v3 decoding solely to refuse retained custody. No current producer
// creates or upgrades these records, and process death never reclaims them.
const payloadSchema = z.discriminatedUnion("version", [
  cancellingPayloadSchema,
  currentPayloadSchema,
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

// A retired v1 record names one process. It predates both the executor/helper
// split and native custody, so it can never carry a v3 borrower.
const retiredPayloadSchema = z.strictObject({
  version: z.literal(1),
  ...nativeProcessIdentityShape,
});

export function parseManagedHandoffLeasePayload(value: string) {
  try {
    return payloadSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Distinguish an exactly decoded retired record from unreadable prospective data. */
export function parseRetiredManagedHandoffLeasePayload(value: string) {
  try {
    const parsed = retiredPayloadSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isRetiredManagedHandoffLeasePayload(value: string): boolean {
  return parseRetiredManagedHandoffLeasePayload(value) !== null;
}
