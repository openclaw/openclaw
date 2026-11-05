import path from "node:path";
import { z } from "zod";
import { restartSentinelPayloadSchema } from "./restart-sentinel-store.js";
import { processIdentitySchema } from "./update-managed-service-handoff-schema.js";
import type { ManagedHandoffSentinelRequest } from "./update-managed-service-handoff-sentinel.js";

const text = z.string().min(1).max(4096);
const absolutePath = text.refine(path.isAbsolute);
const revision = z.number().int().nonnegative().safe().nullable();
const identity = z.strictObject({
  handoffId: text,
  runId: text.optional(),
  root: absolutePath,
});
const boundedPayload = z
  .unknown()
  .refine((value) => {
    try {
      const encoded = JSON.stringify(value);
      return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= 65_536;
    } catch {
      return false;
    }
  })
  .pipe(restartSentinelPayloadSchema)
  .refine((payload) => payload.kind === "update");

/** Internal transport accepts bounded handoff facts, never database configuration or SQL. */
export const managedHandoffSentinelRequestSchema = z.strictObject({
  operation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("inspect"), input: identity }),
    z.strictObject({
      kind: z.literal("record"),
      input: identity.extend({
        expectedRevision: revision.optional(),
        completedStatus: z.enum(["ok", "error", "skipped"]).optional(),
        restored: z.boolean().optional(),
        foreground: z.boolean().optional(),
        fallbackPayload: boundedPayload,
        reason: text,
        triageHint: text,
        serviceKind: z.enum(["systemd", "launchd", "schtasks", "foreground"]),
        handoffFailure: text,
      }),
    }),
  ]),
  databaseIdentity: z.strictObject({
    databasePath: absolutePath,
    databaseIdentity: text,
    parentIdentity: text,
  }),
  helper: processIdentitySchema,
}) satisfies z.ZodType<ManagedHandoffSentinelRequest>;
