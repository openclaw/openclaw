import { execFile } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

export const sha = "a".repeat(40);

export function runWatcher(
  ghScript: string,
  headSha = sha,
  options: string[] = [],
  clock: "poll" | "wall" | { readClock: string } = "poll",
  envOverrides: NodeJS.ProcessEnv = {},
  notifierPath?: string,
) {
  return withTempDir("openclaw-watch-pr-ci-", async (binDir) => {
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, ghScript);
    chmodSync(ghPath, 0o755);
    const clockPath = join(binDir, "poll-clock.mjs");
    // Evidence fixtures advance polling only, independent of fake gh startup cost.
    // Deadline coverage explicitly retains the real clock and child timeout.
    // The unmodified CLI wrapper inherits the clock; gh children keep the original Node options.
    writeFileSync(
      clockPath,
      `import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
if (process.argv[1] === ${JSON.stringify(fileURLToPath(new URL("../../scripts/watch-pr-ci.mts", import.meta.url)))}) {
  process.env.NODE_OPTIONS = ${JSON.stringify(process.env.NODE_OPTIONS ?? "")};
  const now = ${typeof clock === "object" ? `() => Number(readFileSync(${JSON.stringify(clock.readClock)}, "utf8"))` : clock === "wall" ? "Date.now" : "() => 0"};
  const nextTurn = timers.setImmediate;
  let waitedMs = 0;
  Date.now = () => now() + waitedMs;
  timers.setTimeout = async (milliseconds, value, options) => {
    const result = await nextTurn(value, options);
    waitedMs += milliseconds;
    return result;
  };
  syncBuiltinESMExports();
}
`,
    );
    return await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          notifierPath ? "/bin/bash" : process.execPath,
          [
            ...(notifierPath
              ? [
                  "-c",
                  'exec 3>"$1"; shift; exec "$@"',
                  "watcher-notifier",
                  notifierPath,
                  process.execPath,
                ]
              : []),
            "scripts/watch-pr-ci.mjs",
            "42",
            headSha,
            "--attach-timeout",
            "1",
            "--timeout",
            "1",
            "--interval",
            "1",
            ...options,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              ...envOverrides,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(clockPath).href}`,
              PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
          (error, stdout, stderr) => {
            const status = error ? error.code : 0;
            if (typeof status !== "number") {
              reject(new Error("watcher process did not report an exit code", { cause: error }));
              return;
            }
            resolve({ status, stdout, stderr });
          },
        );
      },
    );
  });
}
