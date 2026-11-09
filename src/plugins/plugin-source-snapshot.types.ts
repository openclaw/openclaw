import { z } from "zod";

const SnapshotPathSchema = z.object({ artifact: z.object({ path: z.string() }) });

/** Even malformed named snapshots retain their path for diagnosis and retirement. */
export function pluginSourceSnapshotArtifactPath(value: unknown): string | undefined {
  const parsed = SnapshotPathSchema.safeParse(value);
  return parsed.success ? parsed.data.artifact.path : undefined;
}

/** Persistent source facts only: runtime instances and admissions remain independently owned. */
export const PluginSourceSnapshotDescriptorSchema = z.strictObject({
  formatVersion: z.number().int().positive(),
  generation: z.string().min(1),
  installedRevision: z.number().int().nonnegative(),
  installRecordHash: z.string().min(1),
  packageIntegrity: z.string().min(1).optional(),
  contentDigest: z.string().min(1),
  dependencyClosureDigest: z.string().min(1),
  buildResolutionDigest: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  abi: z.string().min(1),
  artifact: z.strictObject({
    path: z.string().min(1),
    identity: z.string().min(1),
    manifestIdentity: z.string().min(1),
    manifestDigest: z.string().min(1),
    tokenIdentity: z.string().min(1),
  }),
});

export type PluginSourceSnapshotDescriptor = z.infer<typeof PluginSourceSnapshotDescriptorSchema>;

export type PluginSourceSnapshotBinding = Pick<
  PluginSourceSnapshotDescriptor,
  | "installRecordHash"
  | "contentDigest"
  | "dependencyClosureDigest"
  | "buildResolutionDigest"
  | "packageIntegrity"
>;

export type PluginSourceSnapshotPublication = {
  pluginId: string;
  installOwner: string;
  rootDir: string;
  descriptor: Omit<PluginSourceSnapshotDescriptor, "installedRevision">;
};

export type PluginSourceSnapshotWarning = {
  artifactPath: string;
  message: string;
};

type PluginSourceSnapshotRemoval = {
  pluginId: string;
  installOwner: string;
  rootDir: string;
  installRecordHash: string;
  expectedSnapshot: unknown;
  warning: PluginSourceSnapshotWarning;
};

export type PluginSourceSnapshotChanges = {
  sourceSnapshots?: readonly PluginSourceSnapshotPublication[];
  sourceSnapshotRemovals?: readonly PluginSourceSnapshotRemoval[];
  sourceSnapshotRetirements?: readonly Omit<PluginSourceSnapshotDescriptor, "installedRevision">[];
  sourceSnapshotRestorations?: readonly PluginSourceSnapshotIndexChange[];
  collectedSourceSnapshots?: readonly PluginSourceSnapshotDescriptor[];
};

const PluginSourceSnapshotIndexStateSchema = z.strictObject({
  installOwner: z.string().min(1).optional(),
  rootDir: z.string().min(1),
  installRecordHash: z.string().min(1).optional(),
  sourceSnapshot: z.unknown().optional(),
  sourceSnapshotWarning: z
    .strictObject({ artifactPath: z.string(), message: z.string() })
    .optional(),
});
export type PluginSourceSnapshotIndexState = z.infer<typeof PluginSourceSnapshotIndexStateSchema>;
export const PluginSourceSnapshotIndexChangeSchema = z.strictObject({
  pluginId: z.string().min(1),
  before: PluginSourceSnapshotIndexStateSchema.nullable(),
  after: PluginSourceSnapshotIndexStateSchema.nullable(),
});
export type PluginSourceSnapshotIndexChange = z.infer<typeof PluginSourceSnapshotIndexChangeSchema>;
