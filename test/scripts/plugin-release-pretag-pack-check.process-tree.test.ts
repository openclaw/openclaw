// This proof exercises the pretag caller against a real stalled runtime-build process tree.
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
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginReleasePretagPackCheck } from "../../scripts/plugin-release-pretag-pack-check.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
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

function readPid(pidFile: string): number {
  return existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for proof fixture");
    }
    await delay(25);
  }
}

function createProofRepo(): {
  descendantPidFile: string;
  directPidFile: string;
  repoDir: string;
} {
  const repoDir = tempDirs.make("openclaw-plugin-pretag-proof-");
  const scriptsDir = join(repoDir, "scripts");
  const directPidFile = join(repoDir, "runtime-build.pid");
  const descendantPidFile = join(repoDir, "runtime-build-descendant.pid");
  mkdirSync(scriptsDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writePublishablePluginFixture(repoDir, {
    version: "2026.8.26",
    publishTo: "npm",
  });

  // The production caller resolves the tsx loader from its cwd before launching this fixture.
  const nodeModulesDir = join(repoDir, "node_modules");
  mkdirSync(nodeModulesDir);
  symlinkSync(realpathSync(resolve("node_modules/tsx")), join(nodeModulesDir, "tsx"), "dir");
  writeFileSync(
    join(scriptsDir, "check-plugin-npm-runtime-builds.mts"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendant = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); process.send("ready");'], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  descendant.disconnect();
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return { descendantPidFile, directPidFile, repoDir };
}

describe("scripts/plugin-release-pretag-pack-check.ts process-tree proof", () => {
  posixIt(
    "bounds a stalled runtime build and leaves no process-tree descendant alive",
    async () => {
      const { descendantPidFile, directPidFile, repoDir } = createProofRepo();
      const timeoutMs = 100;
      let descendantPid = 0;
      let directPid = 0;
      const startedAt = Date.now();
      const releaseAndWait = startProcessWatchdogFixture(() => {
        const command = runPluginReleasePretagPackCheck(repoDir, { timeoutMs });
        void command.catch(() => {});
        return command;
      });
      try {
        await waitFor(() => readPid(directPidFile) > 1 && readPid(descendantPidFile) > 1);
        directPid = readPid(directPidFile);
        descendantPid = readPid(descendantPidFile);
        expect(isProcessAlive(directPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        const readyAt = Date.now();
        let thrown: unknown;
        try {
          await releaseAndWait();
        } catch (error) {
          thrown = error;
        }
        const elapsedMs = Date.now() - startedAt;
        const completionMs = Date.now() - readyAt;

        expect(thrown).toMatchObject({
          code: "ETIMEDOUT",
          message:
            "plugin runtime build for @openclaw/demo-plugin timed out after 100ms: node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package extensions/demo-plugin",
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 0.75);
        expect(completionMs).toBeLessThan(7_500);
        expect(Number.isInteger(directPid) && directPid > 1).toBe(true);
        expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true);
        await waitFor(() => !isProcessAlive(directPid) && !isProcessAlive(descendantPid));

        const proof = {
          timeoutCode: (thrown as { code?: string }).code,
          elapsedMs,
          completionMs,
          completionBounded: completionMs < 7_500,
          directExited: !isProcessAlive(directPid),
          descendantExited: !isProcessAlive(descendantPid),
        };
        console.log(`pretag-caller-process-tree-proof ${JSON.stringify(proof)}`);
        expect(proof).toMatchObject({
          timeoutCode: "ETIMEDOUT",
          completionBounded: true,
          directExited: true,
          descendantExited: true,
        });
      } finally {
        await releaseAndWait().catch(() => {});
        directPid ||= readPid(directPidFile);
        descendantPid ||= readPid(descendantPidFile);
        killProcessIfAlive(directPid);
        killProcessIfAlive(descendantPid);
      }
    },
    30_000,
  );

  posixIt(
    "rejects a build leader that exits successfully while a descendant remains",
    async () => {
      const { descendantPidFile, directPidFile, repoDir } = createProofRepo();
      writeFileSync(join(repoDir, "scripts/plugin-npm-publish.sh"), "#!/bin/bash\nexit 0\n");
      writeFileSync(
        join(repoDir, "scripts/check-plugin-npm-runtime-builds.mts"),
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000);'], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  descendant.disconnect();
  descendant.unref();
});
`,
      );
      try {
        await expect(
          runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 5_000 }),
        ).rejects.toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "terminated",
        });
        expect(readPid(descendantPidFile)).toBeGreaterThan(1);
        expect(isProcessAlive(readPid(directPidFile))).toBe(false);
        expect(isProcessAlive(readPid(descendantPidFile))).toBe(false);
      } finally {
        killProcessIfAlive(readPid(directPidFile));
        killProcessIfAlive(readPid(descendantPidFile));
      }
    },
    15_000,
  );
});

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
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveCompletion, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pretag CLI fixture exceeded its outer safety deadline"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolveCompletion({ code, signal, stdout, stderr });
    });
  });
  void completion.catch(() => {});
  return { child, completion };
}

describe("pretag executable and per-stage deadlines", () => {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    posixIt(
      `joins the build tree and returns ${code} for ${signal}`,
      async () => {
        const { descendantPidFile, directPidFile, repoDir } = createProofRepo();
        const cli = startProofCli(repoDir);
        try {
          await waitFor(() => readPid(directPidFile) > 1 && readPid(descendantPidFile) > 1);
          expect(isProcessAlive(readPid(directPidFile))).toBe(true);
          expect(isProcessAlive(readPid(descendantPidFile))).toBe(true);
          expect(cli.child.kill(signal)).toBe(true);
          const result = await cli.completion;
          expect(result).toMatchObject({ code, signal: null });
          expect(result.stderr).toContain(`failed with exit code ${code}`);
          expect(isProcessAlive(readPid(directPidFile))).toBe(false);
          expect(isProcessAlive(readPid(descendantPidFile))).toBe(false);
          expect(result.stdout).not.toContain("npm pack:");
        } finally {
          killProcessIfAlive(readPid(directPidFile));
          killProcessIfAlive(readPid(descendantPidFile));
          if (cli.child.exitCode === null && cli.child.signalCode === null) {
            cli.child.kill("SIGKILL");
          }
          await cli.completion.catch(() => {});
        }
      },
      20_000,
    );
  }

  posixIt(
    "preserves a real build failure at the executable boundary and does not pack",
    async () => {
      const { repoDir } = createProofRepo();
      writeFileSync(
        join(repoDir, "scripts/check-plugin-npm-runtime-builds.mts"),
        "process.exit(7);\n",
      );
      const cli = startProofCli(repoDir);
      const result = await cli.completion;
      expect(result).toMatchObject({ code: 7, signal: null });
      expect(result.stderr).toContain("failed with exit code 7");
      expect(result.stdout).not.toContain("npm pack:");
    },
    20_000,
  );

  for (const stage of ["npm", "ClawHub"] as const) {
    posixIt(
      `bounds the real ${stage} pack command and joins its descendants`,
      async () => {
        const { repoDir, directPidFile, descendantPidFile } = createProofRepo();
        writePublishablePluginFixture(repoDir, { version: "2026.8.26", publishTo: "both" });
        const scriptsDir = join(repoDir, "scripts");
        writeFileSync(
          join(scriptsDir, "stall.mts"),
          readFileSync(join(scriptsDir, "check-plugin-npm-runtime-builds.mts")),
        );
        writeFileSync(
          join(scriptsDir, "check-plugin-npm-runtime-builds.mts"),
          "process.exit(0);\n",
        );
        writeFileSync(
          join(scriptsDir, "plugin-npm-publish.sh"),
          stage === "npm"
            ? "#!/bin/bash\nexec node --import tsx scripts/stall.mts\n"
            : "#!/bin/bash\nexit 0\n",
        );
        writeFileSync(
          join(scriptsDir, "plugin-clawhub-publish.sh"),
          "#!/bin/bash\nexec node --import tsx scripts/stall.mts\n",
        );
        try {
          await expect(
            runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 2_000 }),
          ).rejects.toMatchObject({
            code: "ETIMEDOUT",
            message: expect.stringContaining(`${stage} pack for @openclaw/demo-plugin timed out`),
          });
          expect(readPid(descendantPidFile)).toBeGreaterThan(1);
          expect(isProcessAlive(readPid(directPidFile))).toBe(false);
          expect(isProcessAlive(readPid(descendantPidFile))).toBe(false);
        } finally {
          killProcessIfAlive(readPid(directPidFile));
          killProcessIfAlive(readPid(descendantPidFile));
        }
      },
      15_000,
    );
  }

  posixIt(
    "lets two plugins complete real independent build and pack budgets",
    async () => {
      const { repoDir } = createProofRepo();
      for (const extensionId of ["demo-plugin", "second-plugin"]) {
        writePublishablePluginFixture(repoDir, {
          extensionId,
          version: "2026.8.26",
          publishTo: "both",
        });
      }
      const scriptsDir = join(repoDir, "scripts");
      const recordPath = join(repoDir, "stages.jsonl");
      const stageCode = `import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), prebuilt: process.env.OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD, outputDir: process.env.OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR }) + "\\n");
// Six sequential stages must collectively exceed one 2s stage budget while
// each individual stage remains comfortably within it.
await delay(350);
`;
      writeFileSync(join(scriptsDir, "check-plugin-npm-runtime-builds.mts"), stageCode);
      writeFileSync(join(scriptsDir, "pack.mts"), stageCode);
      for (const name of ["plugin-npm-publish.sh", "plugin-clawhub-publish.sh"]) {
        writeFileSync(
          join(scriptsDir, name),
          '#!/bin/bash\nexec node --import tsx scripts/pack.mts "$@"\n',
        );
      }
      const started = Date.now();
      await runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 2_000 });
      expect(Date.now() - started).toBeGreaterThan(2_000);
      const records = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { args: string[]; prebuilt?: string; outputDir?: string },
        );
      expect(records.map((record) => record.args)).toEqual([
        ["--package", "extensions/demo-plugin"],
        ["--pack-dry-run", "extensions/demo-plugin"],
        ["--pack", "extensions/demo-plugin"],
        ["--package", "extensions/second-plugin"],
        ["--pack-dry-run", "extensions/second-plugin"],
        ["--pack", "extensions/second-plugin"],
      ]);
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
});
