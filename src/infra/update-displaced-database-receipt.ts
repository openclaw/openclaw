/** Receipt for `<db>.migrated-<runId>` files a database rollback moved aside. */
import type { BigIntStats } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeTextAtomic } from "./json-files.js";

/** Update run ids as the run ledger issues them; also names capture and receipt files. */
export const UPDATE_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const RECEIPT_SUFFIX = ".receipt.json";

const ReceiptSchema = z
  .object({
    kind: z.literal("update-rollback-displaced-database"),
    version: z.literal(1),
    runId: z.string().regex(UPDATE_RUN_ID_PATTERN),
    databasePath: z.string().refine((value) => path.isAbsolute(value)),
    files: z
      .array(
        z.object({
          path: z.string(),
          dev: z.string(),
          ino: z.string(),
          size: z.string(),
          mtimeNs: z.string(),
        }),
      )
      .max(SUFFIXES.length),
  })
  // A receipt can only name its own family; it never authorizes any other path.
  .refine((receipt) =>
    receipt.files.every((file, index, files) =>
      SUFFIXES.some(
        (suffix) =>
          file.path === displacedDatabasePath(receipt.databasePath, receipt.runId, suffix) &&
          files.findIndex((other) => other.path === file.path) === index,
      ),
    ),
  );
export type DisplacedDatabaseReceipt = z.infer<typeof ReceiptSchema>;

export function displacedDatabasePath(databasePath: string, runId: string, suffix = ""): string {
  return `${databasePath}.migrated-${runId}${suffix}`;
}

export function displacedDatabaseReceiptPath(databasePath: string, runId: string): string {
  return `${displacedDatabasePath(databasePath, runId)}${RECEIPT_SUFFIX}`;
}

/** Splits `<db>.migrated-<runId>[-wal|-shm|-journal][.receipt.json]` into its parts. */
export function parseDisplacedDatabaseName(
  fileName: string,
): { databaseName: string; runId: string; receipt: boolean } | undefined {
  const receipt = fileName.endsWith(RECEIPT_SUFFIX);
  const base = receipt ? fileName.slice(0, -RECEIPT_SUFFIX.length) : fileName;
  const match = /^(.+)\.migrated-([a-zA-Z0-9_-]{1,128})$/u.exec(base);
  if (!match) {
    return undefined;
  }
  let runId = match[2]!;
  if (!receipt) {
    // A sidecar suffix is ambiguous with a run id ending in "-wal"; prefer the family.
    for (const suffix of SUFFIXES.slice(1)) {
      if (runId.endsWith(suffix) && runId.length > suffix.length) {
        runId = runId.slice(0, -suffix.length);
        break;
      }
    }
  }
  return { databaseName: match[1]!, runId, receipt };
}

export function readDisplacedDatabaseReceipt(
  receiptPath: string,
): DisplacedDatabaseReceipt | undefined {
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      return undefined;
    }
    const parsed = ReceiptSchema.safeParse(JSON.parse(fs.readFileSync(receiptPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Written durably before the first rename: a crash after it leaves files the receipt names,
 * a crash before it leaves no displaced file. Identity survives rename (same dev/ino/mtime).
 */
export async function writeDisplacedDatabaseReceipts(
  runId: string,
  moves: readonly { databasePath: string; target: string; identity: BigIntStats }[],
): Promise<void> {
  const byDatabase = new Map<string, DisplacedDatabaseReceipt>();
  for (const { databasePath, target, identity } of moves) {
    const receipt = byDatabase.get(databasePath) ?? {
      kind: "update-rollback-displaced-database" as const,
      version: 1 as const,
      runId,
      databasePath,
      files: [],
    };
    receipt.files.push({
      path: target,
      dev: String(identity.dev),
      ino: String(identity.ino),
      size: String(identity.size),
      mtimeNs: String(identity.mtimeNs),
    });
    byDatabase.set(databasePath, receipt);
  }
  for (const receipt of byDatabase.values()) {
    // Keep the database directory's own mode: the writer would otherwise reset it to the
    // umask default, and private stores (client credentials) refuse a widened directory.
    const directory = path.dirname(receipt.databasePath);
    await writeTextAtomic(
      displacedDatabaseReceiptPath(receipt.databasePath, runId),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600, dirMode: fs.statSync(directory).mode & 0o777, durable: true },
    );
  }
}
