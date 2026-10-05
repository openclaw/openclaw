import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { UpdateSnapshotCapacity } from "../update-snapshot-capacity.js";

const bytes = z.number().int().nonnegative().safe();
const RECEIPT_SCRATCH_BYTES = 16 * 1024 * 1024;
const location = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.resolve(value) === value);
const capacityDemandSchema = z.strictObject({
  directory: location,
  device: z.string(),
  purpose: z.enum(["package-stage-publication", "retained-artifacts", "state-snapshot-scratch"]),
  requiredBytes: bytes,
});
export const upgradeRecipeExecutionCapacitySchema = z.strictObject({
  protocol: z.literal(1),
  measurements: z.strictObject({
    sourceBytes: bytes,
    candidateBytes: bytes,
    runnerBytes: bytes,
    archiveBytes: bytes,
    stateBytes: bytes,
  }),
  demands: z.array(capacityDemandSchema).min(3).max(3),
  filesystems: z
    .array(z.strictObject({ device: z.string(), requiredBytes: bytes, availableBytes: bytes }))
    .min(1)
    .max(3),
});
export type UpgradeRecipeExecutionCapacity = z.infer<typeof upgradeRecipeExecutionCapacitySchema>;

function checked(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Recipe capacity measurement exceeds its exact byte range.");
  }
  return value;
}

/** Count physical allocation and logical copy size, without following symlinks outside the owner. */
async function treeBytes(root: string): Promise<number> {
  if ((await fs.realpath(root)) !== root) {
    throw new Error("Recipe capacity requires canonical measured roots.");
  }
  const rootDevice = (await fs.lstat(root)).dev;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const entry = pending.pop()!;
    const before = await fs.lstat(entry);
    if (before.dev !== rootDevice) {
      throw new Error("Recipe capacity refuses unaccounted nested filesystem mounts.");
    }
    if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) {
      throw new Error("Recipe capacity cannot measure a special filesystem object.");
    }
    total = checked(total + Math.max(before.size, checked(before.blocks * 512)));
    if (before.isDirectory()) {
      const children = await fs.readdir(entry);
      pending.push(...children.map((name) => path.join(entry, name)));
    }
    const after = await fs.lstat(entry);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Recipe capacity source changed during measurement; retry planning.");
    }
  }
  return total;
}

async function filesystem(directory: string) {
  if ((await fs.realpath(directory)) !== directory) {
    throw new Error("Recipe capacity requires canonical filesystem locations.");
  }
  const stat = await fs.stat(directory);
  const capacity = await fs.statfs(directory, { bigint: true });
  const available = capacity.bavail * capacity.bsize;
  if (!stat.isDirectory() || available > BigInt(Number.MAX_SAFE_INTEGER) || available < 0n) {
    throw new Error("Recipe capacity filesystem space is unavailable or exceeds its exact range.");
  }
  return { device: String(stat.dev), availableBytes: Number(available) };
}

/** Conservative simultaneous allocation, grouped by physical device rather than independent path checks. */
export async function measureUpgradeRecipeExecutionCapacity(options: {
  installationRoot: string;
  candidateRoot: string;
  runnerRoot: string;
  archivePath: string;
  artifactsDirectory: string;
  stateRoot: string;
  snapshotCapacity: UpdateSnapshotCapacity;
}): Promise<UpgradeRecipeExecutionCapacity> {
  const snapshot = options.snapshotCapacity;
  if (!snapshot.selection || snapshot.pluginBytes === null) {
    throw new Error(
      "Recipe capacity requires the completed native snapshot inventory and selected filesystem.",
    );
  }
  // The canary removes its private leaf after settlement. Its allocator's parent
  // remains the exact selected volume; never silently substitute another TMPDIR.
  const snapshotDirectory = path.dirname(snapshot.selection.directory);
  const sourceBytes = await treeBytes(options.installationRoot);
  const candidateBytes = await treeBytes(options.candidateRoot);
  const runnerBytes = await treeBytes(options.runnerRoot);
  const archiveBytes = await treeBytes(options.archivePath);
  const stateBytes = await treeBytes(options.stateRoot);
  const specs = [
    {
      directory: path.dirname(options.installationRoot),
      purpose: "package-stage-publication" as const,
      requiredBytes: checked(2 * (sourceBytes + candidateBytes) + 2 * archiveBytes),
    },
    {
      directory: options.artifactsDirectory,
      purpose: "retained-artifacts" as const,
      requiredBytes: checked(runnerBytes + 2 * archiveBytes + RECEIPT_SCRATCH_BYTES),
    },
    {
      directory: snapshotDirectory,
      purpose: "state-snapshot-scratch" as const,
      requiredBytes: checked(
        Math.max(
          snapshot.requiredBytes,
          2 * (stateBytes + RECEIPT_SCRATCH_BYTES) + snapshot.pluginBytes,
        ),
      ),
    },
  ];
  // Two full package copies bound stage and native publication/backup scratch;
  // existing occupied bytes are deliberately not credited as reusable space.
  const demands: UpgradeRecipeExecutionCapacity["demands"] = [];
  const groups = new Map<string, UpgradeRecipeExecutionCapacity["filesystems"][number]>();
  for (const spec of specs) {
    const observed = await filesystem(spec.directory);
    demands.push({ ...spec, device: observed.device });
    const group = groups.get(observed.device) ?? { ...observed, requiredBytes: 0 };
    group.requiredBytes = checked(group.requiredBytes + spec.requiredBytes);
    group.availableBytes = Math.min(group.availableBytes, observed.availableBytes);
    groups.set(observed.device, group);
  }
  const certificate = upgradeRecipeExecutionCapacitySchema.parse({
    protocol: 1,
    measurements: { sourceBytes, candidateBytes, runnerBytes, archiveBytes, stateBytes },
    demands,
    filesystems: [...groups.values()].toSorted((a, b) => a.device.localeCompare(b.device)),
  });
  await assertUpgradeRecipeExecutionCapacity(certificate);
  return certificate;
}

/** Space is an observation, not a reservation: the native snapshot owner also rechecks after inventory. */
async function assertUpgradeRecipeExecutionCapacity(
  selected: UpgradeRecipeExecutionCapacity,
): Promise<void> {
  const certificate = upgradeRecipeExecutionCapacitySchema.parse(selected);
  const { sourceBytes, candidateBytes, archiveBytes, runnerBytes, stateBytes } =
    certificate.measurements;
  const minimums = {
    "package-stage-publication": checked(2 * (sourceBytes + candidateBytes) + 2 * archiveBytes),
    "retained-artifacts": checked(runnerBytes + 2 * archiveBytes + RECEIPT_SCRATCH_BYTES),
    "state-snapshot-scratch": checked(2 * (stateBytes + RECEIPT_SCRATCH_BYTES)),
  };
  if (
    new Set(certificate.demands.map((entry) => entry.purpose)).size !== 3 ||
    certificate.demands.some((entry) => entry.requiredBytes < minimums[entry.purpose])
  ) {
    throw new Error("Recipe capacity omits a simultaneous native allocation demand.");
  }
  const sums = new Map<string, number>();
  for (const demand of certificate.demands) {
    const current = await filesystem(demand.directory);
    if (current.device !== demand.device) {
      throw new Error("Recipe capacity filesystem identity changed; regenerate the approved plan.");
    }
    sums.set(current.device, checked((sums.get(current.device) ?? 0) + demand.requiredBytes));
    const group = certificate.filesystems.find((entry) => entry.device === current.device);
    if (!group || current.availableBytes < group.requiredBytes) {
      throw new Error(
        "Recipe simultaneous execution capacity is insufficient; free space and regenerate the plan.",
      );
    }
  }
  if (
    sums.size !== certificate.filesystems.length ||
    certificate.filesystems.some((group) => sums.get(group.device) !== group.requiredBytes)
  ) {
    throw new Error(
      "Recipe capacity certificate does not aggregate its simultaneous filesystem demands.",
    );
  }
}

/** Re-measure mutable inputs at the native publication boundary, against the approved byte bounds. */
export async function assertUpgradeRecipeCapacityInputs(
  selected: UpgradeRecipeExecutionCapacity,
  roots: {
    installationRoot: string;
    candidateRoot?: string;
    runnerRoot: string;
    archivePath: string;
    stateRoot: string;
  },
): Promise<void> {
  const certificate = upgradeRecipeExecutionCapacitySchema.parse(selected);
  for (const [key, root] of [
    ["sourceBytes", roots.installationRoot],
    ["candidateBytes", roots.candidateRoot],
    ["runnerBytes", roots.runnerRoot],
    ["archiveBytes", roots.archivePath],
    ["stateBytes", roots.stateRoot],
  ] as const) {
    // Native progress/receipt rows are created after planning, before publication.
    // Their explicit scratch allowance is included in simultaneous state demand.
    const limit = checked(
      certificate.measurements[key] + (key === "stateBytes" ? RECEIPT_SCRATCH_BYTES : 0),
    );
    if (root && (await treeBytes(root)) > limit) {
      throw new Error("Recipe capacity input grew beyond its approved bound; regenerate the plan.");
    }
  }
  await assertUpgradeRecipeExecutionCapacity(certificate);
}
