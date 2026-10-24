import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPluginReleasePretagPackCheck } from "../../scripts/plugin-release-pretag-pack-check.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const fixtureLifetime = createFixtureLifetime();
// Join timed-out bodies before releasing their inputs.
afterEach(() => fixtureLifetime.cleanup());
const posixIt = process.platform === "win32" ? it.skip : it;

const readPid = (file: string): number =>
  existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;

function createProofRepo() {
  const repoDir = fixtureLifetime.createTempDir("openclaw-plugin-pretag-proof-");
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

const descendant = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000);'], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  descendant.disconnect();
  descendant.unref();
});
`;
  writeScript("check-plugin-npm-runtime-builds.mts", stallSource);
  return {
    repoDir,
    writeScript,
    pids,
    cleanup: () =>
      pids()
        .filter((pid) => pid > 1)
        .forEach(killPidIfAlive),
  };
}

posixIt(
  "joins an orphaned process tree before rejecting the build",
  ({ signal }) =>
    fixtureLifetime.run(async () => {
      const proof = createProofRepo();
      proof.writeScript("plugin-npm-publish.sh", "#!/bin/bash\nexit 0\n");
      const command = runPluginReleasePretagPackCheck(proof.repoDir, { timeoutMs: 5_000 });
      try {
        await expect(withinTest(command, signal)).rejects.toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "terminated",
        });
        expect(proof.pids().every((pid) => pid > 1)).toBe(true);
        expect(proof.pids().map(isProcessAlive)).toEqual([false, false]);
      } finally {
        await command.catch(() => {});
        proof.cleanup();
      }
    }),
  15_000,
);

posixIt(
  "returns a failed build's exit code without packing",
  () => {
    const { repoDir, writeScript } = createProofRepo();
    writeScript("check-plugin-npm-runtime-builds.mts", "process.exit(7);\n");
    const result = spawnSync(
      process.execPath,
      resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolingTsEntrypoints.pluginPretagPackCheck)),
      {
        cwd: repoDir,
        env: { PATH: process.env.PATH, HOME: repoDir, TMPDIR: repoDir },
        encoding: "utf8",
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    expect(result).toMatchObject({ status: 7, signal: null });
    expect(result.stderr).toContain("failed with exit code 7");
    expect(result.stdout).not.toContain("npm pack:");
  },
  20_000,
);

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
