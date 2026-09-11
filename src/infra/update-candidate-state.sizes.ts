import os from "node:os";
import { z } from "zod";
import { runCommandBuffered } from "../process/exec.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";

// Retain a core-only program: activation can remove the updater package from disk.
// The child owns all source/sidecar stats, including blocked remote filesystem calls.
const inventorySource = `
  const fs = require("node:fs");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const result = [];
    for (const file of JSON.parse(input).files) {
      let size;
      try { size = fs.statSync(file, { bigint: true }).size; }
      catch (error) {
        if (error.code !== "ENOENT") result.push({ path: file });
        continue;
      }
      for (const suffix of ["-wal", "-journal"]) {
        try { size += fs.statSync(file + suffix, { bigint: true }).size; }
        catch (error) {
          if (error.code !== "ENOENT") { size = undefined; break; }
        }
      }
      result.push({ path: file, sizeBytes: size?.toString() });
    }
    process.stdout.write(JSON.stringify(result));
  });
`;
const inventorySchema = z.array(
  z.object({ path: z.string(), sizeBytes: z.string().regex(/^\d+$/).optional() }),
);

/** Measure SQLite families in a bounded child so metadata cannot block updater cancellation. */
export async function readUpdateStateDatabaseSizes(
  files: readonly string[],
  options: {
    nodeRunner: string;
    sourceEnv: NodeJS.ProcessEnv;
    stagingRoot: string;
    signal?: AbortSignal;
  },
): Promise<Array<{ path: string; sizeBytes: bigint | undefined }>> {
  // Until sizes are known, use the existing per-source startup/shutdown budget.
  const result = await runCommandBuffered(
    [options.nodeRunner, "--input-type=commonjs", "--eval", inventorySource],
    {
      cwd: os.tmpdir(),
      input: JSON.stringify({ files }),
      baseEnv: options.sourceEnv,
      env: { XDG_CACHE_HOME: options.stagingRoot },
      signal: options.signal,
      timeoutMs: resolveAggregateSqliteInspectionTimeoutMs(
        "state schema inventory",
        files.map((file) => ({ path: file, sizeBytes: undefined })),
      ),
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `State schema inventory failed (${result.termination}, signal ${result.signal}): ${result.stderr.toString("utf8")}`,
    );
  }
  return inventorySchema.parse(JSON.parse(result.stdout.toString("utf8"))).map((entry) => ({
    path: entry.path,
    sizeBytes: entry.sizeBytes === undefined ? undefined : BigInt(entry.sizeBytes),
  }));
}
