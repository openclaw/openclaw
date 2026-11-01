import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

export async function withUsageWorkerPreload(
  root: string,
  preload: string,
  operation: () => Promise<void>,
) {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  await withEnvAsync({ OPENCLAW_STATE_DIR: root, ...sqliteWorkerPreloadEnv(preload) }, async () => {
    setRuntimeConfigSnapshot({});
    try {
      await operation();
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();
      clearRuntimeConfigSnapshot();
    }
  });
}

export async function observeUsageWorkerReads(root: string, sessionFiles: string[]) {
  const preload = path.join(root, "observe-usage-reads.cjs");
  const log = path.join(root, "usage-reads.jsonl");
  await fs.writeFile(log, "");
  await fs.writeFile(
    preload,
    `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const transcripts = new Set(${JSON.stringify(sessionFiles)});
  const record = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
  for (const [owner, method] of [
    [fs, "createReadStream"], [fs, "open"], [fs, "openSync"],
    [fs, "readFile"], [fs, "readFileSync"],
    [fs.promises, "open"], [fs.promises, "readFile"],
  ]) {
    const original = owner[method];
    owner[method] = function(file, ...args) {
      if (transcripts.has(String(file))) {
        record({ kind: "transcript", method, start: args[0]?.start ?? 0 });
      }
      return Reflect.apply(original, this, [file, ...args]);
    };
  }
  const { DatabaseSync } = require("node:sqlite");
  const zlib = require("node:zlib");
  const decompress = zlib.zstdDecompressSync;
  if (decompress) {
    zlib.zstdDecompressSync = function(data, options) {
      record({ kind: "decompress", outputLimit: options?.maxOutputLength ?? 0 });
      return Reflect.apply(decompress, this, [data, options]);
    };
  }
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    const stats = /^select\\b.*\\bfrom\\s+["\\x60]?transcript_events["\\x60]?/is.test(sql);
    const watermark = sql.includes('as "is_cold"') && sql.includes('"transcript_rewrite_watermarks"');
    const cache = /^select\\b.*\\bfrom\\s+["\\x60]?cache_entries["\\x60]?/is.test(sql);
    if (stats || watermark || cache) {
      for (const method of ["all", "get", "iterate"]) {
        const original = statement[method];
        statement[method] = function(...args) {
          const partitions = cache && args.includes("session-cost-usage-projection-v2");
          const rollup = cache && args.includes("session-cost-usage-rollup-v3");
          if (partitions) record({ kind: "partitions" });
          if (rollup) record({ kind: "cache" });
          if (watermark) record({ kind: "hot-watermark" });
          if (stats) record({ kind: "transcript-stats" });
          if (!rollup && !partitions) return Reflect.apply(original, this, args);
          const observeRow = (row) => record({
            kind: rollup ? "cache-row" : "partition-row", key: row.key,
            blobBytes: row.blob?.byteLength ?? 0,
            valueBytes: typeof row.value_json === "string"
              ? Buffer.byteLength(row.value_json)
              : ArrayBuffer.isView(row.value_json) ? row.value_json.byteLength : 0,
          });
          const result = Reflect.apply(original, this, args);
          if (method === "iterate") {
            return (function* () {
              for (const row of result) {
                observeRow(row);
                yield row;
              }
            })();
          }
          for (const row of method === "all" ? result : result ? [result] : []) observeRow(row);
          return result;
        };
      }
    }
    return statement;
  };
  require("node:module").syncBuiltinESMExports();
}
`,
  );
  return {
    run: (operation: () => Promise<void>) => withUsageWorkerPreload(root, preload, operation),
    clear: () => fs.writeFile(log, ""),
    read: async () =>
      (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as
              | { kind: "transcript-stats" | "hot-watermark" | "cache" | "partitions" }
              | { kind: "decompress"; outputLimit: number }
              | {
                  kind: "cache-row" | "partition-row";
                  key: string;
                  valueBytes: number;
                  blobBytes: number;
                }
              | { kind: "transcript"; method: string; start: number },
        ),
  };
}
