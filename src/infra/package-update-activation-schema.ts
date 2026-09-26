import path from "node:path";
import { z } from "zod";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.resolve(value) === value);
export const packageActivationIdentitySchema = z.string().regex(/^\d+:\d+$/u);
const fingerprint = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: packageActivationIdentitySchema,
  version: z.string().min(1).max(256),
});
export const basename = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value));
const transferName = z.enum(["anchor", "helper", "candidate", "launchers", "previous-launchers"]);
export const PackageActivationDescriptorSchema = z.strictObject({
  layout: z.literal("external-helper"),
  version: z.literal(1),
  operationId: z.uuid(),
  recoveryNodePath: absolutePath,
  authority: z.strictObject({
    databasePath: absolutePath,
    databaseIdentity: packageActivationIdentitySchema,
    parentIdentity: packageActivationIdentitySchema,
    installKey: absolutePath,
    owner: z.string().min(1).max(4096),
  }),
  anchorIdentity: packageActivationIdentitySchema,
  journalIdentity: packageActivationIdentitySchema,
  journalParentIdentity: packageActivationIdentitySchema,
  parentIdentity: packageActivationIdentitySchema,
  binDir: absolutePath,
  binIdentity: packageActivationIdentitySchema,
  originalStageRoot: absolutePath,
  previous: fingerprint,
  candidate: fingerprint,
  launcherRootIdentity: packageActivationIdentitySchema,
  previousLauncherRootIdentity: packageActivationIdentitySchema.nullable(),
  helperIdentity: packageActivationIdentitySchema,
  preparation: z
    .array(
      z.strictObject({
        name: transferName,
        source: absolutePath,
        sourceParentIdentity: packageActivationIdentitySchema,
        identity: packageActivationIdentitySchema,
      }),
    )
    .min(4)
    .max(5),
  helperDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  launchers: z
    .array(
      z.strictObject({
        name: basename,
        previous: z.string().max(4096).nullable(),
        candidate: z.string().max(4096),
        previousIdentity: packageActivationIdentitySchema.nullable(),
        candidateIdentity: packageActivationIdentitySchema,
      }),
    )
    .max(64),
});
export type PackageActivationDescriptor = z.infer<typeof PackageActivationDescriptorSchema>;
export const PackageActivationPhaseSchema = z.enum([
  "preparing",
  "prepared",
  "publishing",
  "publication-complete",
  "rollback-in-progress",
  "rolled-back",
  "aborted",
  "retiring",
  "anchor-retired",
]);
export type PackageActivationPhase = z.infer<typeof PackageActivationPhaseSchema>;
export const intentSchema = z
  .union([
    z.strictObject({
      kind: z.literal("prepare"),
      completed: z.array(transferName).max(5),
      moving: transferName.nullable(),
    }),
    z.strictObject({
      kind: z.enum(["remove-anchor", "unlink-helper"]),
      identity: packageActivationIdentitySchema,
      selected: z.enum(["previous", "candidate"]),
    }),
    z.strictObject({ kind: z.enum(["displace", "publish"]) }),
    z.strictObject({
      kind: z.literal("launcher"),
      name: basename,
      identity: packageActivationIdentitySchema,
    }),
    z.strictObject({ kind: z.literal("retire"), selected: z.enum(["previous", "candidate"]) }),
    z.strictObject({
      kind: z.literal("remove"),
      name: z.enum([
        "previous",
        "candidate",
        "previous.candidate",
        "launchers",
        "previous-launchers",
      ]),
      identity: packageActivationIdentitySchema,
      selected: z.enum(["previous", "candidate"]),
    }),
  ])
  .nullable();
export type PackageActivationIntent = z.infer<typeof intentSchema>;
export type PackageActivationRecord = {
  revision: number;
  phase: PackageActivationPhase;
  intent: PackageActivationIntent;
  descriptor: PackageActivationDescriptor;
  publications: Array<{ name: string; identity: string }>;
};
