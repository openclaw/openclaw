import { formatByteSize } from "@openclaw/normalization-core";
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

export function formatUpdateSnapshotCapacity(capacity: UpdateSnapshotCapacity): string {
  const formatBytes = (value: number) =>
    formatByteSize(value, {
      style: "iec",
      maxUnit: "giga",
      separator: " ",
      fractionDigits: (amount, unit) => (unit === "giga" && amount < 10 ? 1 : 0),
    });
  const measured = `${formatBytes(capacity.sqliteBytes)} SQLite and ${capacity.pluginBytes === null ? "plugin files not yet inspected" : `${formatBytes(capacity.pluginBytes)} plugin files`}`;
  const checked = capacity.candidates
    .map(
      ({ directory, availableBytes, allocationError }) =>
        `${directory}: ${availableBytes === null ? "free space unavailable" : `${formatBytes(availableBytes)} available`}${allocationError ? ` (unavailable: ${allocationError})` : ""}`,
    )
    .join("; ");
  const decision = capacity.selection
    ? `Snapshot location: ${capacity.selection.directory} (${capacity.selection.kind}).`
    : capacity.reason === "snapshot-location-unavailable"
      ? "No snapshot location with enough free space could be allocated."
      : "No snapshot location has enough measured free space.";
  const remedy =
    capacity.reason === "snapshot-location-unavailable"
      ? " Fix the reported path or permissions, or set TMPDIR to a writable directory with sufficient space, then retry the update."
      : " Free space or set TMPDIR to a directory on a filesystem with sufficient space, then retry the update.";
  return `${decision} Snapshot requires ${capacity.pluginBytes === null ? "at least " : ""}${formatBytes(capacity.requiredBytes)} for ${measured} and scratch space. Checked ${checked}.${capacity.selection ? "" : remedy}`;
}

export class UpdateSnapshotCapacityError extends Error {
  readonly reason: UpdateSnapshotCapacity["reason"];
  readonly capacity: UpdateSnapshotCapacity;

  constructor(capacity: UpdateSnapshotCapacity) {
    super(formatUpdateSnapshotCapacity(capacity));
    this.name = "UpdateSnapshotCapacityError";
    this.reason = capacity.reason;
    this.capacity = capacity;
  }
}
