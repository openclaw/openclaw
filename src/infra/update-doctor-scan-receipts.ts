import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { formatErrorMessage } from "./errors.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";

// Optional, operation-local IPC through the existing Doctor invocation/result channel.
export const UPDATE_DOCTOR_HISTORICAL_SCANS_ENV = "OPENCLAW_UPDATE_DOCTOR_HISTORICAL_SCANS";
export const UpdateDoctorHistoricalScansSchema = z
  .array(
    z.object({
      key: z.string().regex(/^[0-9a-f]{64}$/u),
      databasePath: z
        .string()
        .max(4096)
        .refine((value) => path.isAbsolute(value)),
      generation: z.string().max(256),
    }),
  )
  .max(128);
export type UpdateDoctorHistoricalScans = z.infer<typeof UpdateDoctorHistoricalScansSchema>;

// Only an interval guard, never a durable generation or a substitute for the owner's
// full content fingerprint. stat does not open/close raw descriptors beside SQLite.
function observeFileFamily(pathname: string): string {
  return JSON.stringify(
    ["", "-wal", "-journal"].map((suffix) => {
      const file = fs.statSync(pathname + suffix, { bigint: true, throwIfNoEntry: false });
      if (!file) {
        return null;
      }
      if (!file.isFile()) {
        throw new Error("SQLite scan source is not a regular file: " + pathname + suffix);
      }
      return [file.dev, file.ino, file.birthtimeNs, file.ctimeNs, file.mtimeNs, file.size].map(
        String,
      );
    }),
  );
}

type Scan = { databasePath: string; reused: boolean; complete(): void };
const scans = new AsyncLocalStorage<(pathname: string, key: string) => Scan | undefined>();

/** Call complete only for an exhaustive, clean result, never a warning or partial scan.
 * Implementation IDs belong to the frozen migration and must change with its semantics. */
export function beginUpdateDoctorHistoricalScan(pathname: string, identity: readonly unknown[]) {
  return scans.getStore()?.(pathname, sha256Hex(JSON.stringify(identity)));
}

/** Reuse the update owner's full physical generations and bracket admission with file observations.
 * The maintenance owner holds write custody; these optional hints never authorize a repair. */
export function createUpdateDoctorHistoricalScanCapture(options: {
  env: NodeJS.ProcessEnv;
  warn(message: string): void;
}) {
  const completed = new Map<string, string>();
  const observed = new Map<string, string>();
  let admitted: UpdateDatabaseGenerations = {};
  let previous: UpdateDoctorHistoricalScans = [];
  let warned = false;
  const fallback = (reason: string) => {
    if (!warned) {
      warned = true;
      options.warn(
        "Historical Doctor scan reuse is unavailable (" + reason + "); rescanning retained state.",
      );
    }
  };
  const begin = (pathname: string, key: string): Scan | undefined => {
    try {
      // Backup generations name canonical owners, while profile paths can traverse symlinks.
      const databasePath = fs.realpathSync.native(pathname);
      if (typeof admitted[databasePath] !== "string") {
        return undefined;
      }
      const reused =
        observed.get(databasePath) === observeFileFamily(databasePath) &&
        previous.some(
          (entry) =>
            entry.key === key &&
            entry.databasePath === databasePath &&
            entry.generation === admitted[databasePath],
        );
      // A missing/stale optional hint is ordinary scan work, not a Doctor finding.
      return {
        databasePath,
        reused,
        complete() {
          try {
            // Do not certify the old owner if the profile alias changed during the scan.
            if (fs.realpathSync.native(pathname) !== databasePath) {
              return;
            }
            completed.set(key, databasePath);
          } catch (error) {
            fallback(formatErrorMessage(error));
          }
        },
      };
    } catch (error) {
      fallback(formatErrorMessage(error));
      return undefined;
    }
  };
  return {
    run<T>(operation: () => T): T {
      return scans.run(begin, operation);
    },
    observe(paths: readonly string[]) {
      observed.clear();
      for (const pathname of paths) {
        try {
          // Bracket the existing full generation read, not just the later scan.
          observed.set(pathname, observeFileFamily(pathname));
        } catch (error) {
          fallback(formatErrorMessage(error));
        }
      }
    },
    admit(generations: UpdateDatabaseGenerations) {
      completed.clear();
      admitted = generations;
      const encoded = options.env[UPDATE_DOCTOR_HISTORICAL_SCANS_ENV];
      try {
        previous =
          encoded && encoded.length <= 64 * 1024
            ? UpdateDoctorHistoricalScansSchema.parse(JSON.parse(encoded))
            : [];
      } catch (error) {
        previous = [];
        fallback(formatErrorMessage(error));
      }
    },
    settle(generations: UpdateDatabaseGenerations | undefined): UpdateDoctorHistoricalScans {
      const result = [...completed]
        .flatMap(([key, databasePath]) => {
          const generation = generations?.[databasePath];
          // Only certify an entirely unchanged maintenance interval, including child writes.
          return typeof generation === "string" && generation === admitted[databasePath]
            ? [{ key, databasePath, generation }]
            : [];
        })
        .slice(0, 128);
      completed.clear();
      observed.clear();
      return result;
    },
  };
}
