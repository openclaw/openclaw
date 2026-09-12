import { z } from "zod";

const locationKind = z.enum(["explicit-tmpdir", "state-volume", "system-tmpdir"]);
const bytes = z.number().int().nonnegative();

export const UpdateSnapshotCapacitySchema = z.object({
  reason: z.enum([
    ...locationKind.options,
    "snapshot-capacity-insufficient",
    "snapshot-location-unavailable",
  ]),
  sqliteBytes: bytes,
  pluginBytes: bytes.nullable(),
  requiredBytes: bytes,
  candidates: z
    .array(
      z.object({
        kind: locationKind,
        directory: z.string(),
        availableBytes: bytes.nullable(),
        allocationError: z.string().optional(),
      }),
    )
    .max(3),
  selection: z.object({ kind: locationKind, directory: z.string() }).nullable(),
});

export type UpdateSnapshotCapacity = z.infer<typeof UpdateSnapshotCapacitySchema>;
