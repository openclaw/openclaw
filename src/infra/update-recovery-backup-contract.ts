import path from "node:path";
import { z } from "zod";

export const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const updateRecoveryConfigWriteSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0") && path.resolve(value) === value),
    beforeHash: sha256.nullable(),
    afterHash: sha256.nullable(),
    contiguous: z.boolean(),
  })
  .strict();
export type UpdateRecoveryConfigWrite = z.infer<typeof updateRecoveryConfigWriteSchema>;
export function mergeUpdateRecoveryConfigWrites(
  previous: readonly UpdateRecoveryConfigWrite[],
  next: readonly UpdateRecoveryConfigWrite[],
): UpdateRecoveryConfigWrite[] {
  const merged = new Map(previous.map((entry) => [entry.path, entry]));
  for (const entry of next) {
    const before = merged.get(entry.path);
    merged.set(
      entry.path,
      before
        ? {
            path: entry.path,
            beforeHash: before.beforeHash,
            afterHash: entry.afterHash,
            contiguous:
              before.contiguous && entry.contiguous && before.afterHash === entry.beforeHash,
          }
        : entry,
    );
  }
  return [...merged.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export const updateRecoveryTerminalOutcomeSchema = z
  .object({
    status: z.enum(["restored", "committed"]),
    error: z.string().max(4096).optional(),
    manifestSha256: sha256,
  })
  .strict();

const updateRecoveryRetirementSchema = z
  .object({
    directory: z.string().min(1).max(4096),
    installRoot: z.string().min(1).max(4096),
    stateDir: z.string().min(1).max(4096),
    configPath: z.string().min(1).max(4096),
    identity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict(),
    outcome: z.enum(["committed", "restored"]),
  })
  .strict();
export type UpdateRecoveryRetirement = z.infer<typeof updateRecoveryRetirementSchema>;

export const updateRecoveryCaptureStateSchema = z
  .object({
    manifestSha256: sha256,
    configWrites: z.array(updateRecoveryConfigWriteSchema).max(512),
    status: z.enum(["pending", "restore-failed"]),
    error: z.string().max(4096).optional(),
    doctorCompleted: z.boolean().optional(),
    restored: z.literal(true).optional(),
    retirement: updateRecoveryRetirementSchema.optional(),
  })
  .strict();
export type UpdateRecoveryCaptureState = z.infer<typeof updateRecoveryCaptureStateSchema>;

export function mergeUpdateRecoveryCaptureState(
  previous: UpdateRecoveryCaptureState | undefined,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
): UpdateRecoveryCaptureState {
  if (previous && previous.manifestSha256 !== patch.manifestSha256) {
    throw new Error("Update recovery receipts belong to another capture.");
  }
  return updateRecoveryCaptureStateSchema.parse({
    status: "pending",
    ...previous,
    ...patch,
    ...(previous?.restored ? { restored: true } : {}),
    configWrites: mergeUpdateRecoveryConfigWrites(
      previous?.configWrites ?? [],
      patch.configWrites ?? [],
    ),
  });
}
