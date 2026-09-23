import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { resolveDeliveryQueueMediaDir } from "../config/paths.js";
import { fileStore } from "./file-store.js";
import { spoolRelativePath } from "./outbound/delivery-queue-media-paths.js";

type MediaBackup = { sourcePath: string; name: string; sha256: string; size: number };

/** Capture only the spool owner's paths; never read arbitrary legacy paths or fetch URLs. */
export function resolveLegacyDeliveryQueueMediaPaths(
  entryValue: unknown,
  stateDir: string,
): string[] {
  const entry = asNullableRecord(entryValue);
  const payloads = Array.isArray(entry?.payloads) ? entry.payloads : [];
  const sources: unknown[] = [];
  for (const value of payloads) {
    const payload = asNullableRecord(value);
    sources.push(payload?.mediaUrl);
    if (Array.isArray(payload?.mediaUrls)) {
      sources.push(...payload.mediaUrls);
    }
  }
  if (Array.isArray(entry?.expectedMediaUrls)) {
    sources.push(...entry.expectedMediaUrls);
  }
  const urls = sources.filter(hasNonEmptyString);
  return [
    ...new Set(
      urls
        .filter((source) => path.isAbsolute(source) && spoolRelativePath(source, stateDir))
        .map((source) => path.resolve(source)),
    ),
  ];
}

async function verifyMediaBackup(
  archive: ReturnType<typeof fileStore>,
  backup: MediaBackup,
): Promise<void> {
  const prior = await archive.open(backup.name, { symlinks: "reject", hardlinks: "reject" });
  try {
    if (prior.stat.size !== backup.size) {
      throw new Error("Queue media backup size changed");
    }
    const digest = createHash("sha256");
    for await (const chunk of prior.handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    if (digest.digest("hex") !== backup.sha256) {
      throw new Error("Queue media backup content changed");
    }
  } finally {
    await prior.handle.close();
  }
}

/** Recovery artifacts are independent of spool GC; the receipt records their verified identities. */
export async function preserveLegacyDeliveryQueueMedia(params: {
  mediaPaths: readonly string[];
  previousBackups?: unknown;
  sourcePath: string;
  stateDir: string;
}): Promise<{ directory: string; copies: MediaBackup[] }> {
  const spool = fileStore({ rootDir: resolveDeliveryQueueMediaDir(params.stateDir) });
  const archive = fileStore({
    rootDir: params.sourcePath + ".media.migrated",
    dirMode: 0o700,
    mode: 0o600,
  });
  const copies: MediaBackup[] = [];
  const previous = new Map<string, MediaBackup>();
  if (params.previousBackups !== undefined && !Array.isArray(params.previousBackups)) {
    throw new Error("Invalid queue media backup receipt");
  }
  for (const value of params.previousBackups ?? []) {
    const item = asNullableRecord(value);
    if (
      typeof item?.sourcePath !== "string" ||
      typeof item.name !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.name !== path.basename(item.sourcePath) + "." + item.sha256 ||
      previous.has(item.sourcePath)
    ) {
      throw new Error("Invalid queue media backup identity");
    }
    previous.set(item.sourcePath, {
      sourcePath: item.sourcePath,
      name: item.name,
      sha256: item.sha256,
      size: item.size,
    });
  }
  for (const source of params.mediaPaths) {
    const recorded = previous.get(source);
    if (recorded) {
      // The original spool file may already have been collected after backup completion.
      await verifyMediaBackup(archive, recorded);
      copies.push(recorded);
      continue;
    }
    const opened = await spool.open(path.basename(source), {
      symlinks: "reject",
      hardlinks: "reject",
    });
    const temporary = "copy-" + randomUUID() + ".tmp";
    try {
      const digest = createHash("sha256");
      const input = opened.handle.createReadStream({ autoClose: false });
      const stream = Readable.from(
        (async function* () {
          for await (const chunk of input) {
            digest.update(chunk);
            yield chunk;
          }
        })(),
      );
      await archive.writeStream(temporary, stream, { maxBytes: Math.max(1, opened.stat.size) });
      const after = await opened.handle.stat();
      if (after.size !== opened.stat.size || after.mtimeMs !== opened.stat.mtimeMs) {
        throw new Error("Queue media changed while preserving its migration backup");
      }
      const sha256 = digest.digest("hex");
      const backup = {
        sourcePath: source,
        name: path.basename(source) + "." + sha256,
        sha256,
        size: opened.stat.size,
      };
      if (await archive.exists(backup.name)) {
        await verifyMediaBackup(archive, backup);
      } else {
        await (await archive.root()).move(temporary, backup.name, { overwrite: false });
      }
      copies.push(backup);
    } finally {
      await opened.handle.close();
      if (await archive.exists(temporary)) {
        await archive.remove(temporary);
      }
    }
  }
  return { directory: archive.rootDir, copies };
}
