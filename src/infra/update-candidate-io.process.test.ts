import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each(["deadline", "cancellation", "completion"])(
  "releases native progress IO and exits naturally after %s",
  async (outcome) => {
    const root = dirs.make("update-native-progress-");
    const directory = path.join(root, "snapshot");
    await fs.mkdir(directory);
    const copy = path.join(directory, "database.sqlite");
    await fs.writeFile(copy, "partial");
    const fifo = path.join(root, "metadata.fifo");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5_000 });
    expect(created.status, created.stderr).toBe(0);
    const started = path.join(root, "metadata-started.json");
    const receipt = path.join(root, "outcome.json");
    const naturalExit = path.join(root, "natural-exit");
    const preload = path.join(root, "metadata-preload.cjs");
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const target = ${JSON.stringify(copy)};
const fifo = ${JSON.stringify(fifo)};
const started = ${JSON.stringify(started)};
const stat = fs.promises.stat.bind(fs.promises);
const statSync = fs.statSync.bind(fs);
const readFile = fs.promises.readFile.bind(fs.promises);
function admitted(kind) {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(started, JSON.stringify({ pid: process.pid, kind }));
}
fs.promises.stat = async function(file, ...args) {
  if (file === target) {
    admitted("async-fifo");
    await readFile(fifo);
  }
  return stat(file, ...args);
};
fs.statSync = function(file, ...args) {
  if (file === target) {
    admitted("sync-fifo");
    fs.readFileSync(fifo);
  }
  return statSync(file, ...args);
};
`,
    );
    const helper = path.join(root, "updater.mjs");
    await fs.writeFile(
      helper,
      `import fs from "node:fs";
import { withUpdateCandidateIoBudget } from ${JSON.stringify(new URL("./update-candidate-io.ts", import.meta.url).href)};
const outcome = ${JSON.stringify(outcome)};
const budgetMs = 340000;
const realNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout;
let elapsed = 0;
let watchdog;
Date.now = () => realNow() + elapsed;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = realSetTimeout(callback, delay, ...args);
  if (!watchdog && delay > 300000 && delay <= budgetMs) {
    watchdog = { callback, args };
  }
  return timer;
};
process.once("beforeExit", () => fs.writeFileSync(${JSON.stringify(naturalExit)}, "natural"));
let independentTimerFired = false;
const controller = new AbortController();
let finish;
const work = new Promise(resolve => { finish = resolve; });
let workerSignal;
const operation = withUpdateCandidateIoBudget({
  directory: ${JSON.stringify(directory)},
  bytes: 32 * 1024 ** 2,
  signal: controller.signal,
}, async signal => {
  workerSignal = signal;
  const stopped = () => finish();
  signal.addEventListener("abort", stopped, { once: true });
  try {
    await work;
    return "worker completed";
  } finally {
    signal.removeEventListener("abort", stopped);
  }
}).then(result => ({ result }), error => ({ error: error.message }));
while (!fs.existsSync(${JSON.stringify(started)})) {
  await new Promise(resolve => realSetTimeout(resolve, 10));
}
await new Promise(resolve => realSetTimeout(() => {
  independentTimerFired = true;
  resolve();
}, 10));
const metadata = JSON.parse(fs.readFileSync(${JSON.stringify(started)}, "utf8"));
if (outcome === "cancellation") {
  controller.abort(new Error("cancel native metadata"));
} else if (outcome === "deadline") {
  if (!watchdog) throw new Error("shared watchdog was not armed");
  elapsed = budgetMs;
  watchdog.callback(...watchdog.args);
} else {
  finish();
}
const result = await operation;
Date.now = realNow;
globalThis.setTimeout = realSetTimeout;
const evidence = {
  outcome, budgetMs, independentTimerFired, updaterReturned: true,
  updaterPid: process.pid, probePid: metadata.pid,
  aborted: workerSignal.aborted, ...result,
};
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(evidence));
process.stdout.write(JSON.stringify(evidence) + "\\n");
`,
    );
    const result = await runCommandBuffered(
      [
        process.execPath,
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        helper,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        baseEnv: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
        timeoutMs: 10_000,
        killGraceMs: 300,
        maxOutputBytes: 32 * 1024,
      },
    );
    const rawEvidence = await fs.readFile(receipt, "utf8").catch((cause: unknown) => {
      throw new Error(`Updater did not report its outcome: ${result.stderr.toString()}`, { cause });
    });
    const evidence: unknown = JSON.parse(rawEvidence);
    expect(evidence).toMatchObject({
      outcome,
      budgetMs: 340_000,
      independentTimerFired: true,
      updaterReturned: true,
      aborted: outcome !== "completion",
      ...(outcome === "completion"
        ? { result: "worker completed" }
        : {
            error:
              outcome === "cancellation"
                ? "cancel native metadata"
                : expect.stringContaining(
                    "made no progress for 340 seconds (32 MiB of SQLite state)",
                  ),
          }),
    });
    const diagnostic = JSON.stringify({
      evidence,
      termination: result.termination,
      stderr: result.stderr.toString(),
    });
    expect(
      result.termination,
      `Updater returned but native progress IO prevented exit: ${diagnostic}`,
    ).toBe("exit");
    expect(result.code, diagnostic).toBe(0);
    expect(await fs.readFile(naturalExit, "utf8")).toBe("natural");
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      !("probePid" in evidence) ||
      typeof evidence.probePid !== "number"
    ) {
      throw new Error("Missing metadata probe PID");
    }
    const probePid = evidence.probePid;
    expect(() => process.kill(probePid, 0)).toThrow();
  },
  20_000,
);
