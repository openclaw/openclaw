import fs from "node:fs/promises";
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { sleep } from "../utils/sleep.js";
import { formatDiskSpaceBytes } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";

export async function measureUpdateStateFiles(
  files: Iterable<string>,
): Promise<{ bytes: number; largest: number; families: Array<{ path: string; bytes: number }> }> {
  let bytes = 0;
  let largest = 0;
  const families: Array<{ path: string; bytes: number }> = [];
  for (const file of files) {
    let family = 0;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        family += (await fs.stat(file + suffix)).size;
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    bytes += family;
    largest = Math.max(largest, family);
    families.push({ path: file, bytes: family });
  }
  return { bytes, largest, families };
}

// Core-only code survives package replacement; native filesystem requests stay in this child.
const copyProgressSource = `
  const fs = require("node:fs"), path = require("node:path");
  const { createHash } = require("node:crypto");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
  const facts = [];
  let bytes = 0;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          visit(file);
        } else if (entry.isFile()) {
          const stat = fs.statSync(file);
          bytes += stat.size;
          facts.push([file, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"));
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  visit(JSON.parse(input).directory);
  process.stdout.write(JSON.stringify({
    facts: createHash("sha256").update(facts.sort().join("\\n")).digest("hex"), bytes,
  }));
});
`;
const copyProgressSchema = z.object({
  facts: z.string().length(64),
  bytes: z.number().nonnegative(),
});

/** One IO watchdog for private state workers; callers retain child and scratch ownership. */
export async function withUpdateCandidateIoBudget<T>(
  params: {
    directory: string;
    bytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    operation?: "snapshot" | "inspection";
    nodeRunner?: string;
    env?: NodeJS.ProcessEnv;
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  // Each period without observable progress receives the shared SQLite IO allowance.
  const budgetFor = (bytes: number) =>
    Math.max(
      params.timeoutMs ?? 0,
      resolveSqliteInspectionBudget(
        `update state ${params.operation ?? "inspection"}`,
        params.directory,
        bytes,
      ).timeoutMs,
    );
  let knownBytes = params.bytes;
  let budget = budgetFor(knownBytes);
  let deadline = Date.now() + budget;
  let previous: string | undefined;
  const stalled = new AbortController();
  const finished = new AbortController();
  const signal = AbortSignal.any([stalled.signal, ...(params.signal ? [params.signal] : [])]);
  const monitorSignal = AbortSignal.any([signal, finished.signal]);
  const expire = () =>
    stalled.abort(
      new Error(
        `Update state ${params.operation ?? "inspection"} made no progress for ${budget / 1000} seconds (${formatDiskSpaceBytes(knownBytes)} of SQLite state). Check storage performance before retrying.`,
      ),
    );
  let cancelDeadline = scheduleAbsoluteDeadline(deadline, expire);
  let probeFailure: Error | undefined;
  const monitor = (async () => {
    try {
      while (!monitorSignal.aborted) {
        const probe = await runUtf8CommandWithTimeout(
          [
            params.nodeRunner ?? process.execPath,
            "--input-type=commonjs",
            "--eval",
            copyProgressSource,
          ],
          {
            cwd: os.tmpdir(),
            baseEnv: params.env,
            input: JSON.stringify({ directory: params.directory }),
            signal: monitorSignal,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            killSignal: "SIGKILL",
            maxOutputBytes: { stdout: 1024, stderr: 4000 },
          },
        );
        if (probe.cleanup === "uncertain") {
          throw Object.assign(new Error("Update progress probe cleanup could not be confirmed"), {
            cleanup: probe.cleanup,
          });
        }
        monitorSignal.throwIfAborted();
        if (probe.code !== 0) {
          throw new Error(`Update progress probe failed (${probe.termination}): ${probe.stderr}`);
        }
        const current = copyProgressSchema.parse(JSON.parse(probe.stdout));
        if (Date.now() >= deadline) {
          expire();
          return;
        }
        if (current.bytes > knownBytes || (previous !== undefined && current.facts !== previous)) {
          // Registered external databases may first become visible inside the worker.
          knownBytes = Math.max(knownBytes, current.bytes);
          budget = budgetFor(knownBytes);
          deadline = Date.now() + budget;
          cancelDeadline();
          cancelDeadline = scheduleAbsoluteDeadline(deadline, expire);
        }
        previous = current.facts;
        await sleep(1_000, monitorSignal);
      }
    } catch (error) {
      if (isRecord(error) && error.cleanup === "uncertain") {
        probeFailure =
          error instanceof Error
            ? error
            : new Error("Update progress probe cleanup failed", { cause: error });
      }
      if (!monitorSignal.aborted) {
        stalled.abort(error);
      }
    }
  })();
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await run(signal) };
  } catch (error) {
    outcome = { error };
  }
  if (Date.now() >= deadline) {
    expire();
  }
  finished.abort();
  cancelDeadline();
  await monitor;
  // Uncertain probe cleanup outranks both worker results and caller cancellation.
  if (probeFailure) {
    throw probeFailure;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  signal.throwIfAborted();
  return outcome.value;
}
