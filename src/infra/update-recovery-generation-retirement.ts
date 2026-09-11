import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { pinDirectory, requireDirectorySync, sha256File } from "./directory-durability.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import {
  updateRecoveryTerminalOutcomeSchema,
  type UpdateRecoveryBackupRef,
  type UpdateRecoveryRetirement,
} from "./update-recovery-backup-contract.js";
import { digest, MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";

type Generation = NonNullable<UpdateRecoveryRetirement["generations"]>[number];
type Authority = { assertOwned: () => void };

/** Bind complete C/T artifacts before the terminal owner releases any payload. */
export async function prepareRetainedGenerationRetirement(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<Generation[] | undefined> {
  const generations: Generation[] = [];
  for (const kind of ["candidate", "prepared"] as const) {
    const directory = path.join(ref.directory, kind);
    if (!(await statOrMissing(directory))) {
      continue;
    }
    const source = await safeRoot(directory);
    const raw = (
      await source.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer;
    const manifestSha256 = digest(raw);
    const verified = await prepareVerifiedBackup({
      directory,
      manifestPath: path.join(directory, "manifest.json"),
      manifestSha256,
    });
    try {
      const generation = verified.manifest.generation;
      if (
        generation?.kind !== kind ||
        generation.baselineSha256 !== ref.manifestSha256 ||
        (generation.kind === "prepared" &&
          generation.candidateSha256 !==
            generations.find((entry) => entry.kind === "candidate")?.manifestSha256)
      ) {
        throw new Error("Retained generation retirement binding changed.");
      }
      const pin = await pinDirectory(directory);
      try {
        await verified.assertCurrent();
        authority.assertOwned();
        const { dev, ino, birthtimeMs } = pin.receipt.identity;
        generations.push({ kind, manifestSha256, identity: { dev, ino, birthtimeMs } });
      } finally {
        await pin.close();
      }
    } finally {
      await verified.close();
    }
  }
  return generations.length ? generations : undefined;
}

/** The existing terminal receipt, not missing files, admits interrupted deletion. */
export async function retireRetainedGenerationPayloads(
  ref: UpdateRecoveryBackupRef,
  receipt: UpdateRecoveryRetirement,
  authority: Authority,
): Promise<void> {
  const generations = receipt.generations;
  if (!generations) {
    return;
  }
  if (
    new Set(generations.map((entry) => entry.kind)).size !== generations.length ||
    (generations.some((entry) => entry.kind === "prepared") &&
      !generations.some((entry) => entry.kind === "candidate"))
  ) {
    throw new Error("Invalid retained generation retirement inventory.");
  }
  const plans = [
    {
      kind: "baseline" as const,
      directory: ref.directory,
      manifestSha256: ref.manifestSha256,
      identity: receipt.identity,
    },
    ...generations.map((entry) => ({ ...entry, directory: path.join(ref.directory, entry.kind) })),
  ];
  const opened: Array<{
    plan: (typeof plans)[number];
    pin: Awaited<ReturnType<typeof pinDirectory>>;
    source: Awaited<ReturnType<typeof safeRoot>>;
    files: Map<string, BigIntStats>;
    payload: boolean;
  }> = [];
  try {
    // Validate the whole remaining set before deleting anything from any generation.
    for (const plan of plans) {
      authority.assertOwned();
      if (!(await statOrMissing(plan.directory))) {
        continue;
      }
      const pin = await pinDirectory(plan.directory);
      const source = await safeRoot(plan.directory).catch(async (error: unknown) => {
        await pin.close();
        throw error;
      });
      const item = { plan, pin, source, files: new Map<string, BigIntStats>(), payload: false };
      opened.push(item);
      const directoryIdentity = pin.receipt.identity;
      if (
        directoryIdentity.dev !== plan.identity.dev ||
        directoryIdentity.ino !== plan.identity.ino ||
        directoryIdentity.birthtimeMs !== plan.identity.birthtimeMs
      ) {
        throw new Error("Retained generation retirement directory was replaced.");
      }
      const allowed = new Set(["manifest.json", "payload", UPDATE_CAPTURE_PRIVACY_MARKER]);
      if (plan.kind === "baseline") {
        allowed.add("outcome.json");
        for (const generation of generations) {
          allowed.add(generation.kind);
        }
      }
      for (const entry of await source.list("", { withFileTypes: true })) {
        if (!allowed.has(entry.name)) {
          throw new Error(`Update capture contains unowned retirement input: ${entry.name}`);
        }
      }
      if (
        plan.kind === "baseline" &&
        (await statOrMissing(path.join(plan.directory, "outcome.json")))
      ) {
        const raw = (
          await source.read("outcome.json", {
            maxBytes: 16 * 1024,
            symlinks: "reject",
            hardlinks: "reject",
          })
        ).buffer;
        const outcome = updateRecoveryTerminalOutcomeSchema.parse(JSON.parse(raw.toString()));
        if (outcome.manifestSha256 !== ref.manifestSha256 || outcome.status !== receipt.outcome) {
          throw new Error("Update capture retirement outcome changed.");
        }
      }
      item.payload = Boolean(await statOrMissing(path.join(plan.directory, "payload")));
      const manifestExists = await statOrMissing(path.join(plan.directory, "manifest.json"));
      if (!manifestExists && item.payload) {
        throw new Error("Retirement manifest is missing before payload settlement.");
      }
      for (const filename of ["manifest.json", UPDATE_CAPTURE_PRIVACY_MARKER]) {
        if (!(await statOrMissing(path.join(plan.directory, filename)))) {
          continue;
        }
        const file = await source.open(filename, { symlinks: "reject", hardlinks: "reject" });
        try {
          const before = await file.handle.stat({ bigint: true });
          if (before.size > BigInt(MAX_MANIFEST_BYTES)) {
            throw new Error("Retirement metadata exceeds its bound.");
          }
          const raw = await file.handle.readFile();
          if (!sameFileMutationFingerprint(before, await file.handle.stat({ bigint: true }))) {
            throw new Error("Retirement metadata changed while reading.");
          }
          item.files.set(filename, before);
          if (filename === UPDATE_CAPTURE_PRIVACY_MARKER) {
            if (raw.toString() !== UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT) {
              throw new Error("Retirement privacy marker changed.");
            }
            continue;
          }
          const manifest = parseUpdateRecoveryBackupManifest(raw.toString());
          if (
            digest(raw) !== plan.manifestSha256 ||
            manifest.runId !== path.basename(ref.directory) ||
            manifest.installRoot !== receipt.installRoot ||
            manifest.stateDir !== receipt.stateDir ||
            manifest.configPath !== receipt.configPath
          ) {
            throw new Error("Retirement manifest identity changed.");
          }
          if (plan.kind !== "baseline") {
            const generation = manifest.generation;
            if (
              generation?.kind !== plan.kind ||
              generation.baselineSha256 !== ref.manifestSha256 ||
              (generation.kind === "prepared" &&
                generation.candidateSha256 !==
                  generations.find((entry) => entry.kind === "candidate")?.manifestSha256)
            ) {
              throw new Error("Retained generation retirement binding changed.");
            }
          }
          if (!item.payload) {
            continue;
          }
          const entries = new Map(
            manifest.entries
              .filter((entry) => entry.kind === "file")
              .map((entry) => [entry.archivePath, entry]),
          );
          for (const child of await source.list("payload", { withFileTypes: true })) {
            const payloadName = `payload/${child.name}`;
            const entry = entries.get(payloadName);
            if (!entry || !child.isFile || child.isSymbolicLink) {
              throw new Error(`Update capture contains unowned retirement payload: ${payloadName}`);
            }
            const payload = await source.open(payloadName, {
              symlinks: "reject",
              hardlinks: "reject",
            });
            try {
              const payloadIdentity = await payload.handle.stat({ bigint: true });
              const actual = await sha256File(payload.handle);
              if (
                !sameFileMutationFingerprint(
                  payloadIdentity,
                  await payload.handle.stat({ bigint: true }),
                ) ||
                actual.bytes !== entry.size ||
                actual.digest !== entry.sha256
              ) {
                throw new Error(`Update retirement payload changed: ${payloadName}`);
              }
              item.files.set(payloadName, payloadIdentity);
            } finally {
              await payload.handle.close();
            }
          }
        } finally {
          await file.handle.close();
        }
      }
    }
    const assertCurrent = async () => {
      for (const item of opened) {
        await item.pin.assertCurrent();
      }
      authority.assertOwned();
    };
    // Children retire first; B's metadata remains until the existing terminal tail.
    for (const item of opened.toReversed()) {
      for (const [filename, identity] of item.files) {
        if (!filename.startsWith("payload/")) {
          continue;
        }
        await assertCurrent();
        const current = await fs.lstat(path.join(item.plan.directory, filename), { bigint: true });
        if (!sameFileMutationFingerprint(identity, current)) {
          throw new Error(`Update retirement payload changed before removal: ${filename}`);
        }
        authority.assertOwned();
        await item.source.remove(filename);
      }
      if (item.payload) {
        await assertCurrent();
        await item.source.remove("payload");
      }
      requireDirectorySync(await item.pin.sync(), "Retained generation payload retirement");
    }
    const baseline = opened.find((item) => item.plan.kind === "baseline");
    if (!baseline) {
      throw new Error("Retirement baseline directory disappeared.");
    }
    for (const item of opened.toReversed().filter((entry) => entry.plan.kind !== "baseline")) {
      for (const filename of [UPDATE_CAPTURE_PRIVACY_MARKER, "manifest.json"]) {
        const identity = item.files.get(filename);
        if (!identity) {
          continue;
        }
        await baseline.pin.assertCurrent();
        await item.pin.assertCurrent();
        authority.assertOwned();
        const current = await fs.lstat(path.join(item.plan.directory, filename), { bigint: true });
        if (!sameFileMutationFingerprint(identity, current)) {
          throw new Error("Retirement metadata changed before removal.");
        }
        authority.assertOwned();
        await item.source.remove(filename);
      }
      requireDirectorySync(await item.pin.sync(), "Retained generation metadata retirement");
      await baseline.pin.assertCurrent();
      await item.pin.assertCurrent();
      authority.assertOwned();
      await fs.rmdir(item.plan.directory);
    }
    requireDirectorySync(await baseline.pin.sync(), "Retained generation parent retirement");
  } finally {
    for (const item of opened.toReversed()) {
      await item.pin.close();
    }
  }
}
