import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureReceiptClientSource } from "../../../test/helpers/fixture-receipts.js";

// SIGTERM plus the adapter's kill-wait fallback is a fixed ~9s production window.
export const FORCED_SETTLEMENT_TEST_TIMEOUT_MS = 60_000;

/** The caller owns cwd and must retain leakPidPath before starting the root. */
export async function createLeakedPipeScope(cwd: string, receiptEndpoint: string) {
  const leakPath = path.join(cwd, "leak.mjs");
  const leakPidPath = path.join(cwd, "leak.pid");
  const leakTickPath = path.join(cwd, "leak.ticks");
  const leakReadyPath = path.join(cwd, "leak.ready");
  const rootPath = path.join(cwd, "root.mjs");
  await writeFile(
    leakPath,
    `
      import { appendFileSync, writeFileSync } from "node:fs";
      ${fixtureReceiptClientSource(receiptEndpoint)}
      // Adapter disposal closes the parent-side pipes. Keep the escaped process
      // alive so its independent tick file proves output attempts continue.
      process.stdout.on("error", () => {});
      process.stderr.on("error", () => {});
      let tick = 0;
      setInterval(() => {
        tick += 1;
        appendFileSync(process.argv[3], ".");
        process.stdout.write("leaked-stdout-" + tick + "\\n");
        process.stderr.write("leaked-stderr-" + tick + "\\n");
      }, 50);
      writeFileSync(${JSON.stringify(leakReadyPath)}, "ready");
      sendReceipt(${JSON.stringify(leakReadyPath)}, "ready");
    `,
    "utf8",
  );
  await writeFile(
    rootPath,
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      process.stdout.write("live-stdout\\n");
      process.stderr.write("live-stderr\\n");
      // Inherit this root's stdout/stderr so the pipes outlive it, and detach so
      // the supervisor's process-group kill cannot reach the descendant. This is
      // the shipped CLI shape that would leave stdio open without terminal disposal.
      const leak = spawn(
        process.execPath,
        [${JSON.stringify(leakPath)}, ${JSON.stringify(leakPidPath)}, ${JSON.stringify(leakTickPath)}],
        { stdio: ["ignore", "inherit", "inherit"], detached: true },
      );
      // Retain identity before child boot, including when the test aborts during readiness.
      writeFileSync(${JSON.stringify(leakPidPath)}, String(leak.pid));
      leak.unref();
      setInterval(() => {}, 1_000);
    `,
    "utf8",
  );
  return { cwd, rootPath, leakPidPath, leakTickPath, leakReadyPath };
}
