import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";

export function installedLifecycleLogging(rootDir: string, role: string) {
  return {
    level: "debug",
    consoleLevel: "silent",
    file: path.join(rootDir, `lifecycle-${role}.log`),
    maxFileBytes: 4 * 1024 * 1024,
  };
}

/** Export scalar phase receipts, never the raw log (which can contain private diagnostics). */
export async function readInstalledLifecycleEvents(task: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}) {
  const events: Record<string, string | number | boolean | null>[] = [];
  let malformed = 0;
  let omitted = 0;
  for (const suffix of [".5", ".4", ".3", ".2", ".1", ""]) {
    const filename = path.join(task.rootDir, `lifecycle-selected${suffix}.log`);
    try {
      // The isolated logger has the same cap; refuse an unexpected unbounded input at egress.
      if ((await fs.stat(filename)).size > 4 * 1024 * 1024) {
        return { events, unavailable: "Lifecycle log exceeded its capture limit" };
      }
      for (const line of (await fs.readFile(filename, "utf8")).split(/\r?\n/u)) {
        if (!line.includes("update-phase ")) {
          continue;
        }
        try {
          const record = asOptionalRecord(JSON.parse(line));
          const message = Object.values(record ?? {}).find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("update-phase "),
          );
          if (!message) {
            continue;
          }
          const event = asOptionalRecord(JSON.parse(message.slice("update-phase ".length)));
          const safe: Record<string, string | number | boolean | null> = {};
          for (const key of [
            "timestamp",
            "pid",
            "ppid",
            "phase",
            "event",
            "startedAtMs",
            "elapsedMs",
            "action",
            "operationId",
            "remainingMs",
            "childPid",
            "outcome",
            "code",
            "status",
            "termination",
            "cleanup",
            "stdoutBytes",
            "stderrBytes",
          ]) {
            const value = event?.[key];
            if (typeof value === "string") {
              safe[key] = redactSupportString(value, task, { maxLength: 128 });
            } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
              safe[key] = value;
            }
          }
          if (safe.phase) {
            if (events.length < 4096) {
              events.push(safe);
            } else {
              omitted++;
            }
          }
        } catch {
          // A forced updater kill can leave the final queued record incomplete.
          malformed++;
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        return { events, unavailable: "Lifecycle log could not be read" };
      }
    }
  }
  return { events, malformed, omitted, captureLimit: 4096 };
}
