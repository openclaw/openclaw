import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { runPluginReleasePretagPackCheck } from "../../scripts/plugin-release-pretag-pack-check.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { withinTest } from "../helpers/promise.js";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const fixtureLifetime = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirs) => {
  afterEach(async () => {
    // Vitest's timeout settles before the body finally; join that body before removing its inputs.
    await fixtureLifetime.cleanup();
    cleanupDirs();
  });
});
const posixIt = process.platform === "win32" ? it.skip : it;
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") {
      return true;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

function killProcessIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The managed runner may have reaped the fixture between the liveness check and signal.
  }
}

const readPid = (file: string): number =>
  existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;

function createProofRepo(leaderExits = false) {
  const repoDir = tempDirs.make("openclaw-plugin-pretag-proof-");
  const scriptsDir = join(repoDir, "scripts");
  const directPidFile = join(repoDir, "runtime-build.pid");
  const descendantPidFile = join(repoDir, "runtime-build-descendant.pid");
  mkdirSync(scriptsDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writePublishablePluginFixture(repoDir, { version: "2026.8.26", publishTo: "npm" });
  const writeScript = (name: string, source: string) =>
    writeFileSync(join(scriptsDir, name), source);
  const pids = () => [readPid(directPidFile), readPid(descendantPidFile)];

  // The production caller resolves the tsx loader from its cwd before launching this fixture.
  const nodeModulesDir = join(repoDir, "node_modules");
  mkdirSync(nodeModulesDir);
  symlinkSync(realpathSync(resolve("node_modules/tsx")), join(nodeModulesDir, "tsx"), "dir");
  const stallSource = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
${leaderExits ? "" : fixtureReceiptClientSource(receipts.endpoint)}

const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(leaderExits ? 'process.send("ready"); setInterval(() => {}, 1000);' : 'setInterval(() => {}, 1000); process.send("ready");')}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  ${leaderExits ? "" : `sendReceipt(${JSON.stringify(directPidFile)}, "ready");`}
  descendant.disconnect();
  ${leaderExits ? "descendant.unref();" : ""}
});
${leaderExits ? "" : "setInterval(() => {}, 1000);"}
`;
  writeScript("check-plugin-npm-runtime-builds.mts", stallSource);
  return {
    repoDir,
    writeScript,
    stallSource,
    pids,
    async ready(operation: PromiseLike<unknown>) {
      // PID records precede the receipt; settlement can overtake its delivery.
      const requireRecorded = (error: unknown) => {
        if (!pids().every((pid) => pid > 1)) {
          throw error;
        }
      };
      await Promise.race([
        receipts.waitFor(directPidFile, "ready"),
        Promise.resolve(operation).then(
          () => requireRecorded(new Error("timed out waiting for proof fixture")),
          requireRecorded,
        ),
      ]);
    },
    expectAlive: (alive: boolean) => expect(pids().map(isProcessAlive)).toEqual([alive, alive]),
    expectTerminated: () => {
      expect(readPid(descendantPidFile)).toBeGreaterThan(1);
      expect(pids().map(isProcessAlive)).toEqual([false, false]);
    },
    cleanup: () => pids().forEach(killProcessIfAlive),
  };
}

for (const [stage, timeoutMs, testTimeout] of [
  ["runtime build", 100, 30_000],
  ["orphan", 5_000, 15_000],
  ["npm", 2_000, 15_000],
  ["ClawHub", 2_000, 15_000],
] as const) {
  posixIt(
    `joins the process tree after ${stage} failure`,
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const proof = createProofRepo(stage === "orphan");
        const { repoDir, writeScript, stallSource } = proof;
        if (stage === "orphan") {
          writeScript("plugin-npm-publish.sh", "#!/bin/bash\nexit 0\n");
        } else if (stage === "npm" || stage === "ClawHub") {
          writePublishablePluginFixture(repoDir, { version: "2026.8.26", publishTo: "both" });
          writeScript("stall.mts", stallSource);
          writeScript("check-plugin-npm-runtime-builds.mts", "process.exit(0);\n");
          const stall = "#!/bin/bash\nexec node --import tsx scripts/stall.mts\n";
          writeScript("plugin-npm-publish.sh", stage === "npm" ? stall : "#!/bin/bash\nexit 0\n");
          writeScript("plugin-clawhub-publish.sh", stall);
        }
        let command = Promise.resolve();
        const startedAt = Date.now();
        const start = () => {
          command = runPluginReleasePretagPackCheck(repoDir, { timeoutMs });
          void command.catch(() => {});
          return command;
        };
        const build = stage === "runtime build";
        const releaseAndWait = build ? startProcessWatchdogFixture(start) : () => command;
        if (!build) {
          void start();
        }
        let pids: number[] = [];
        let readyAt = startedAt;
        try {
          if (build) {
            await withinTest(proof.ready(command), signal);
            pids = proof.pids();
            expect(pids.map(isProcessAlive)).toEqual([true, true]);
            readyAt = Date.now();
          }
          const expected =
            stage === "orphan"
              ? { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "terminated" }
              : {
                  code: "ETIMEDOUT",
                  message: build
                    ? "plugin runtime build for @openclaw/demo-plugin timed out after 100ms: node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package extensions/demo-plugin"
                    : expect.stringContaining(`${stage} pack for @openclaw/demo-plugin timed out`),
                };
          await expect(withinTest(releaseAndWait(), signal)).rejects.toMatchObject(expected);
          if (build) {
            const elapsedMs = Date.now() - startedAt;
            const completionMs = Date.now() - readyAt;
            expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 0.75);
            expect(completionMs).toBeLessThan(7_500);
            expect(pids.map(isProcessAlive)).toEqual([false, false]);
          } else {
            proof.expectTerminated();
          }
        } finally {
          await releaseAndWait().catch(() => {});
          (pids.length ? pids : proof.pids()).forEach(killProcessIfAlive);
        }
      }),
    testTimeout,
  );
}

function startProofCli(repoDir: string) {
  const child = spawn(
    process.execPath,
    resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolingTsEntrypoints.pluginPretagPackCheck)),
    {
      cwd: repoDir,
      env: { PATH: process.env.PATH, HOME: repoDir, TMPDIR: repoDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const completion = new Promise<number | null>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", resolveCompletion);
  }).then((code) => ({ code, signal: child.signalCode, stdout, stderr }));
  void completion.catch(() => {});
  return {
    child,
    completion,
    async cleanup(signal: NodeJS.Signals) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
      await completion.catch(() => {});
    },
  };
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  [null, 7],
] as const) {
  posixIt(
    `returns ${code} for ${signal ?? "a failed build"} without packing or leaving descendants`,
    ({ signal: testSignal }) =>
      fixtureLifetime.run(async () => {
        const proof = createProofRepo();
        if (!signal) {
          proof.writeScript("check-plugin-npm-runtime-builds.mts", "process.exit(7);\n");
        }
        const cli = startProofCli(proof.repoDir);
        try {
          if (signal) {
            await withinTest(proof.ready(cli.completion), testSignal);
            proof.expectAlive(true);
            expect(cli.child.kill(signal)).toBe(true);
          }
          const result = await withinTest(cli.completion, testSignal);
          expect(result).toMatchObject({ code, signal: null });
          expect(result.stderr).toContain(`failed with exit code ${code}`);
          expect(result.stdout).not.toContain("npm pack:");
          if (signal) {
            proof.expectAlive(false);
          }
        } finally {
          proof.cleanup();
          await cli.cleanup(signal ? "SIGKILL" : "SIGTERM");
        }
      }),
    20_000,
  );
}

posixIt(
  "lets two plugins complete real independent build and pack budgets",
  async () => {
    const { repoDir, writeScript } = createProofRepo();
    for (const extensionId of ["demo-plugin", "second-plugin"]) {
      writePublishablePluginFixture(repoDir, {
        extensionId,
        version: "2026.8.26",
        publishTo: "both",
      });
    }
    const recordPath = join(repoDir, "stages.jsonl");
    const stageCode = `import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), prebuilt: process.env.OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD, outputDir: process.env.OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR }) + "\\n");
// Six 350ms stages exceed one 2s budget while each remains comfortably within it.
await delay(350);
`;
    writeScript("check-plugin-npm-runtime-builds.mts", stageCode);
    writeScript("pack.mts", stageCode);
    for (const name of ["plugin-npm-publish.sh", "plugin-clawhub-publish.sh"]) {
      writeScript(name, '#!/bin/bash\nexec node --import tsx scripts/pack.mts "$@"\n');
    }
    const started = Date.now();
    await runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 2_000 });
    expect(Date.now() - started).toBeGreaterThan(2_000);
    const records = readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; prebuilt?: string; outputDir?: string });
    expect(records.map((record) => record.args)).toEqual(
      ["demo-plugin", "second-plugin"].flatMap((id) =>
        ["--package", "--pack-dry-run", "--pack"].map((flag) => [flag, `extensions/${id}`]),
      ),
    );
    for (const index of [1, 2, 4, 5]) {
      expect(records[index]?.prebuilt).toBe("0");
    }
    expect(records[2]?.outputDir).toContain("clawhub-0");
    expect(records[5]?.outputDir).toContain("clawhub-1");
    for (const index of [2, 5]) {
      expect(existsSync(records[index]!.outputDir!)).toBe(false);
    }
  },
  20_000,
);
