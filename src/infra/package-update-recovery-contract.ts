import path from "node:path";
import { z } from "zod";

const text = z.string().min(1).max(32_768);
const absolute = text.refine((value) => path.isAbsolute(value) && path.resolve(value) === value);
const launcherName = text.refine(
  (value) => value !== "." && value !== ".." && !/[\\/]/u.test(value),
);
const fingerprint = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: z.string().regex(/^\d+:\d+$/u),
  version: text,
});
const selection = z.strictObject({
  pairId: z.uuid(),
  ownerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const retention = z.discriminatedUnion("state", [
  selection.extend({ state: z.literal("selected") }),
  z.strictObject({
    state: z.literal("unselected"),
    ownerRevision: selection.shape.ownerRevision,
  }),
  selection.extend({
    state: z.literal("superseded"),
    replacement: z.strictObject({
      pairId: z.uuid(),
      transactionId: z.uuid(),
      live: fingerprint,
      retainedRoot: absolute,
      retained: fingerprint,
      launchers: z.array(z.strictObject({ name: launcherName, fingerprint: text })).max(64),
    }),
  }),
]);

/** Operational data for Recovery's store, not a sidecar or deletion authority. */
export const PackageTransactionDescriptorSchema = z
  .strictObject({
    version: z.literal(1),
    transactionId: z.uuid(),
    packageName: z
      .string()
      .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu)
      .max(214),
    liveRoot: absolute,
    stageRoot: absolute,
    backupRoot: absolute,
    binDir: absolute,
    shimBackupRoot: absolute.nullable(),
    shimBackupIdentity: text.nullable(),
    previous: fingerprint.nullable(),
    candidate: fingerprint,
    launchers: z
      .array(
        z.strictObject({
          name: launcherName,
          previous: text.nullable(),
          candidate: text,
        }),
      )
      .max(64),
    // Missing launchers observed when a prior activation intent was reconciled
    // as interrupted. Clear only after verified restoration, not on a retry.
    interruptedLaunchers: z.array(launcherName).max(64),
    retention: retention.nullable(),
  })
  .superRefine((value, ctx) => {
    const parent = path.resolve(value.liveRoot, ...value.packageName.split("/").map(() => ".."));
    if (
      value.liveRoot === path.parse(value.liveRoot).root ||
      value.stageRoot === path.parse(value.stageRoot).root ||
      value.binDir === path.parse(value.binDir).root ||
      path.join(parent, value.packageName) !== value.liveRoot ||
      value.packageName === "." ||
      value.packageName === ".." ||
      (value.shimBackupRoot === null) !== (value.shimBackupIdentity === null) ||
      path.dirname(value.backupRoot) !== parent ||
      !path.basename(value.backupRoot).startsWith(".openclaw.package-backup-") ||
      value.stageRoot === value.liveRoot ||
      value.stageRoot.startsWith(`${value.liveRoot}${path.sep}`) ||
      value.liveRoot.startsWith(`${value.stageRoot}${path.sep}`) ||
      (value.shimBackupRoot !== null &&
        (path.dirname(value.shimBackupRoot) !== parent ||
          !path.basename(value.shimBackupRoot).startsWith(".openclaw.shim-backup-"))) ||
      value.launchers.some((entry) => entry.previous !== null && !value.shimBackupRoot) ||
      value.interruptedLaunchers.some(
        (name) => !value.launchers.some((entry) => entry.name === name),
      ) ||
      new Set(value.launchers.map((entry) => entry.name)).size !== value.launchers.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid package recovery paths or launcher inventory",
      });
    }
  });

export const PackageRecoveryEffectSchema = z.strictObject({
  effectId: z.uuid(),
  action: z.enum(["activate", "restore", "retire"]),
  descriptor: PackageTransactionDescriptorSchema,
});
