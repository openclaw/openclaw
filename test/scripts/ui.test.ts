// Ui tests cover ui script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  isDirectScriptExecution,
  resolveUiBuildEnvironment,
  resolvePnpmSpawnCall,
} from "../../scripts/ui.mts";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../../src/gateway/control-ui-root-assets.js";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.js";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { isPidDefinitelyDead } from "../../src/shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function copyUiFixture(root: string): void {
  for (const file of [
    "scripts/ui.js",
    "scripts/ui.mts",
    "scripts/pnpm-runner.mts",
    "scripts/run-node-package-bin.mts",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/build-identity.mts",
    "scripts/lib/output-root-guard.mjs",
    "scripts/lib/record-shared.mjs",
    "src/infra/process-env.ts",
    "src/infra/windows-process-start.ts",
    "src/shared/freebsd-process-identity.ts",
    "src/shared/freebsd-process-identity-native.ts",
    "src/shared/pid-alive.ts",
    "ui/package.json",
    "ui/src/build-info-normalizers.ts",
    "packages/normalization-core/src/record-coerce.ts",
    "packages/normalization-core/src/string-coerce.ts",
    "packages/normalization-core/src/utf16-slice.ts",
  ]) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
}

function writeUiPackageBin(modules: string, name: string, source: string): string {
  const directory = path.join(modules, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: { ".": "./entry.mjs", "./package.json": "./package.json" },
      bin: { [name]: "./entry.mjs" },
    }),
  );
  const entry = path.join(directory, "entry.mjs");
  fs.writeFileSync(entry, source);
  return entry;
}

// writeFileSync creates the file before its content lands, so an existence
// poll can observe an empty file on loaded runners; wait for bytes instead.
function readNonEmpty(file: string): string | null {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function withUiProcessCleanup(
  wrapper: ChildProcess,
  root: string,
  pidFiles: string[],
  run: () => Promise<void>,
): Promise<void> {
  const readPid = (file: string): number | null => {
    const value = readNonEmpty(file);
    if (value === null) {
      return null;
    }
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid fixture PID in ${file}`);
    }
    return pid;
  };
  await runQaGatewayFixture(
    run,
    () => fs.writeFileSync(path.join(root, "release"), "release"),
    async () => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        await waitForExit(wrapper);
      }
    },
    ...pidFiles.map((file) => async () => {
      const pid = readPid(file);
      if (pid !== null) {
        await waitFor(() => !pidAlive(pid), "UI fixture process exit", 5_000);
      }
    }),
    () => {
      if (
        (wrapper.exitCode === null && wrapper.signalCode === null) ||
        pidFiles.some((file) => {
          const pid = readPid(file);
          return pid !== null && pidAlive(pid);
        })
      ) {
        throw new Error(`UI fixture cleanup is unverified; retained ${root}`);
      }
      fs.rmSync(root, { force: true, recursive: true });
    },
  );
}

describe("scripts/ui", () => {
  it("reuses the runtime identity for the documented standalone UI rebuild", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const firstBuild = normalizeControlUiBuildInfo({
      version: "2026.8.1",
      commit,
      builtAt: "2026-08-14T23:00:00.000Z",
    });

    const env = resolveUiBuildEnvironment({
      env: {},
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => firstBuild,
      readGitCommit: () => commit,
      readPackageVersion: () => "2026.8.1",
    });
    const rebuiltUi = normalizeControlUiBuildInfo({
      version: "2026.8.1",
      commit: env.GIT_COMMIT,
      builtAt: env.OPENCLAW_BUILD_TIMESTAMP,
      buildId: env.OPENCLAW_CONTROL_UI_BUILD_ID,
    });

    expect(rebuiltUi).toMatchObject({
      builtAt: firstBuild.builtAt,
      buildId: firstBuild.buildId,
      commit: firstBuild.commit,
      version: firstBuild.version,
    });
  });

  it("does not reuse build info from a different source revision", () => {
    const env = resolveUiBuildEnvironment({
      env: {},
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => ({
        version: "2026.8.1",
        commit: "a".repeat(40),
        builtAt: "2026-08-14T23:00:00.000Z",
      }),
      readGitCommit: () => "b".repeat(40),
      readPackageVersion: () => "2026.8.1",
    });

    expect(env).toMatchObject({
      GIT_COMMIT: "b".repeat(40),
      OPENCLAW_BUILD_TIMESTAMP: "2026-08-14T23:05:00.000Z",
    });
    expect(env.OPENCLAW_CONTROL_UI_BUILD_ID).toBeUndefined();
  });

  it("does not reuse non-release build info for a release UI build", () => {
    const commit = "a".repeat(40);
    const env = resolveUiBuildEnvironment({
      env: { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1" },
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => ({
        version: "2026.8.1",
        commit,
        builtAt: "2026-08-14T23:00:00.000Z",
        release: false,
      }),
      readGitCommit: () => commit,
      readPackageVersion: () => "2026.8.1",
    });

    expect(env).toMatchObject({
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-08-14T23:05:00.000Z",
    });
    expect(env.OPENCLAW_CONTROL_UI_BUILD_ID).toBeUndefined();
  });

  it("rejects unsafe Windows pnpm shim arguments before launch", () => {
    for (const argument of ["evil&calc", "%PATH%"]) {
      expect(() =>
        resolvePnpmSpawnCall(
          ["install", argument],
          { PATH: "" },
          {
            npmExecPath: "",
            platform: "win32",
          },
        ),
      ).toThrow(/unsafe windows cmd\.exe argument/i);
    }
  });

  it("routes Windows Corepack pnpm entrypoints through node", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.mjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      expect(
        resolvePnpmSpawnCall(
          ["run", "build"],
          {
            npm_execpath: npmExecPath,
            ComSpec: "C:\\Windows\\System32\\cmd.exe",
          },
          {
            cwd: "C:\\repo\\ui",
            nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
            platform: "win32",
          },
        ),
      ).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "run", "build"],
        options: {
          cwd: "C:\\repo\\ui",
          stdio: "inherit",
          env: {
            npm_execpath: npmExecPath,
            ComSpec: "C:\\Windows\\System32\\cmd.exe",
          },
          shell: false,
          windowsVerbatimArguments: undefined,
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("detects direct execution through a junctioned script path", () => {
    const realScriptPath = path.resolve("repo/openclaw/scripts/ui.js");
    const junctionScriptPath = path.resolve("linked/openclaw/scripts/ui.js");
    const realpath = (entry: string) => (entry === junctionScriptPath ? realScriptPath : entry);

    expect(isDirectScriptExecution(junctionScriptPath, realScriptPath, realpath)).toBe(true);
  });

  it.each(["--help", "-h"])("keeps no-pnpm build %s informational", (helpFlag) => {
    const result = spawnSync(testNodeExecPath, ["scripts/ui.js", "build", helpFlag], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        PATH: "",
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toContain("Missing UI runner");
    expect(output).toContain("vite");
    expect(output).not.toContain("Control UI performance");
  });

  it.each([
    { layout: "hoisted", action: "build", args: ["build"], noPnpm: false },
    { layout: "isolated", action: "build", args: ["build"], noPnpm: true },
    { layout: "hoisted", action: "dev", args: [], noPnpm: false },
    {
      layout: "isolated",
      action: "test",
      args: ["run", "--config", "vitest.config.ts"],
      noPnpm: false,
    },
  ])(
    "runs $action from $layout dependencies without package shims (noPnpm=$noPnpm)",
    ({ action, args, layout, noPnpm }) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-layout-")));
      const ui = path.join(root, "ui");
      const modules = path.join(layout === "isolated" ? ui : root, "node_modules");
      const expectedExit = action === "test" ? 17 : 0;
      const forwarded = ["--help", "--mode", "fixture with spaces & symbols"];
      try {
        copyUiFixture(root);
        for (const name of [
          "vite",
          "vitest",
          "dompurify",
          "@vitest/browser-playwright",
          "playwright",
        ]) {
          writeUiPackageBin(
            modules,
            name,
            `console.log(JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  commit: process.env.GIT_COMMIT, timestamp: process.env.OPENCLAW_BUILD_TIMESTAMP
}));
process.exitCode = ${expectedExit};\n`,
          );
        }
        const pnpm = path.join(root, "pnpm.cjs");
        fs.writeFileSync(
          pnpm,
          'throw new Error("Installed UI tools must not need package shims");\n',
        );
        const result = spawnSync(testNodeExecPath, ["scripts/ui.js", action, ...forwarded], {
          cwd: root,
          encoding: "utf8",
          env: mergeProcessEnv([
            process.env,
            {
              PATH: "",
              npm_execpath: pnpm,
              OPENCLAW_BUILD_ALL_NO_PNPM: noPnpm ? "1" : "0",
              OPENCLAW_BUILD_TIMESTAMP: "2026-08-27T00:00:00.000Z",
              GIT_COMMIT: "a".repeat(40),
            },
          ]),
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(expectedExit);
        expect(JSON.parse(result.stdout)).toEqual({
          args: [...args, ...forwarded],
          cwd: ui,
          commit: "a".repeat(40),
          timestamp: "2026-08-27T00:00:00.000Z",
        });
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  const liveUiBuildSiblings = [
    `control-ui.build-${process.pid}-live`,
    `control-ui.build-${process.pid}-live.retired`,
  ];
  it.each([
    {
      label: "a: Vite failure without prior output",
      prior: false,
      retiredOnly: false,
      viteExit: 1,
      performanceExit: 0,
      seedSiblings: false,
      publishDenials: 0,
      expectedExit: 1,
      expectedHealth: "missing-index",
      expectedOutputId: null,
      expectedDistEntries: [],
      expectedWaits: [],
      expectedStderr: null,
    },
    {
      label: "b: Vite failure with stale output",
      prior: true,
      retiredOnly: false,
      viteExit: 1,
      performanceExit: 0,
      seedSiblings: false,
      publishDenials: 0,
      expectedExit: 1,
      expectedHealth: "stale",
      expectedOutputId: "stale-runtime",
      expectedDistEntries: ["control-ui"],
      expectedWaits: [],
      expectedStderr: null,
    },
    {
      label: "c: performance validator failure with stale output",
      prior: true,
      retiredOnly: false,
      viteExit: 0,
      performanceExit: 17,
      seedSiblings: false,
      publishDenials: 0,
      expectedExit: 17,
      expectedHealth: "stale",
      expectedOutputId: "stale-runtime",
      expectedDistEntries: ["control-ui"],
      expectedWaits: [],
      expectedStderr: null,
    },
    {
      label: "d: success replacing stale output and cleaning dead siblings",
      prior: true,
      retiredOnly: false,
      viteExit: 0,
      performanceExit: 0,
      seedSiblings: true,
      publishDenials: 0,
      expectedExit: 0,
      expectedHealth: "ready",
      expectedOutputId: "fixture-runtime",
      expectedDistEntries: ["control-ui", ...liveUiBuildSiblings],
      expectedWaits: [],
      expectedStderr: null,
    },
    {
      label: "e: EPERM publication failure with stale output",
      prior: true,
      retiredOnly: false,
      viteExit: 0,
      performanceExit: 0,
      seedSiblings: false,
      publishDenials: 100,
      expectedExit: 1,
      expectedHealth: "stale",
      expectedOutputId: "stale-runtime",
      expectedDistEntries: ["control-ui"],
      expectedWaits: [100, 200, 400, 800, 1600],
      expectedStderr: "Failed to publish Control UI build; previous output retained.",
    },
    {
      label: "f: interrupted swap restored before a failed retry",
      prior: false,
      retiredOnly: true,
      viteExit: 1,
      performanceExit: 0,
      seedSiblings: false,
      publishDenials: 0,
      expectedExit: 1,
      expectedHealth: "stale",
      expectedOutputId: "stale-runtime",
      expectedDistEntries: ["control-ui"],
      expectedWaits: [],
      expectedStderr: null,
    },
    {
      label: "g: transient publication denial clears",
      prior: true,
      retiredOnly: false,
      viteExit: 0,
      performanceExit: 0,
      seedSiblings: false,
      publishDenials: 2,
      expectedExit: 0,
      expectedHealth: "ready",
      expectedOutputId: "fixture-runtime",
      expectedDistEntries: ["control-ui"],
      expectedWaits: [100, 200],
      expectedStderr: null,
    },
  ])(
    "publishes only validated complete output ($label)",
    ({
      prior,
      retiredOnly,
      viteExit,
      performanceExit,
      seedSiblings,
      publishDenials,
      expectedExit,
      expectedHealth,
      expectedOutputId,
      expectedDistEntries,
      expectedWaits,
      expectedStderr,
    }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-ui-publication-"));
      copyUiFixture(root);
      const output = path.join(root, "dist/control-ui");
      const deadPid = 2_147_483_647;
      if (seedSiblings || retiredOnly) {
        expect(isPidDefinitelyDead(deadPid)).toBe(true);
      }
      const buildId = "fixture-runtime";
      const buildFiles = (id: string) => ({
        "index.html": `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${id}-${"a".repeat(64)}"><script type="module" src="./assets/index.js"></script></html>`,
        "assets/index.js": `console.log(${JSON.stringify(id)});`,
        "assets/lazy.js": `export default ${JSON.stringify(id)};`,
      });
      if (prior || retiredOnly) {
        const priorOutput = retiredOnly
          ? path.join(root, "dist", `control-ui.build-${deadPid}-x.retired`)
          : output;
        for (const [file, bytes] of Object.entries(buildFiles("stale-runtime"))) {
          fs.mkdirSync(path.dirname(path.join(priorOutput, file)), { recursive: true });
          fs.writeFileSync(path.join(priorOutput, file), bytes);
        }
      }
      if (retiredOnly) {
        const unfinished = path.join(root, "dist", `control-ui.build-${deadPid}-y`);
        fs.mkdirSync(unfinished);
        fs.writeFileSync(path.join(unfinished, "junk"), "incomplete");
      }
      const modules = path.join(root, "node_modules");
      writeUiPackageBin(modules, "dompurify", "export {};\n");
      writeUiPackageBin(
        modules,
        "vite",
        `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const out = args.includes("--outDir") ? args[args.lastIndexOf("--outDir") + 1] : path.resolve("../dist/control-ui");
for (const [file, bytes] of Object.entries(${JSON.stringify(buildFiles(buildId))})) {
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
  fs.writeFileSync(path.join(out, file), bytes);
}
console.log(JSON.stringify({ tool: "vite", out, args }));
process.exitCode = ${viteExit};
`,
      );
      for (const [validator, name, exitCode] of [
        ["check-control-ui-precompressed-assets.mts", "precompressed", 0],
        ["check-control-ui-performance.mts", "performance", performanceExit],
      ] as const) {
        fs.writeFileSync(
          path.join(root, "scripts", validator),
          `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const out = args.includes("--dist") ? args[args.indexOf("--dist") + 1]
  : args.find(arg => !arg.startsWith("--")) ?? path.resolve("dist/control-ui");
console.log(JSON.stringify({ tool: ${JSON.stringify(name)}, out, args }));
if (out && !fs.existsSync(path.join(out, "index.html"))) throw new Error("missing staged index");
process.exitCode = ${exitCode};
`,
        );
      }
      const fsGuard = path.join(root, "fs-guard.cjs");
      const waitsFile = path.join(root, "rename-waits.json");
      fs.writeFileSync(
        fsGuard,
        `
const fs = require("node:fs");
const rename = fs.renameSync;
let remainingDenials = ${publishDenials};
const waits = [];
Atomics.wait = (_array, _index, _value, delay) => {
  waits.push(delay);
  return "timed-out";
};
process.on("exit", () => fs.writeFileSync(${JSON.stringify(waitsFile)}, JSON.stringify(waits)));
fs.renameSync = function(from, to) {
  if (to === ${JSON.stringify(output)} && !from.endsWith(".retired") && remainingDenials > 0) {
    remainingDenials -= 1;
    throw Object.assign(new Error("fixture publication failure"), { code: "EPERM" });
  }
  return rename(from, to);
};
require("node:module").syncBuiltinESMExports();
`,
      );
      const args = [
        "--require",
        fsGuard,
        "scripts/ui.js",
        "build",
        "--mode",
        "fixture with spaces",
      ];
      if (seedSiblings) {
        for (const name of [
          ...liveUiBuildSiblings,
          `control-ui.build-${deadPid}-dead`,
          `control-ui.build-${deadPid}-dead.retired`,
        ]) {
          fs.mkdirSync(path.join(root, "dist", name), { recursive: true });
          fs.writeFileSync(path.join(root, "dist", name, "sentinel"), name);
        }
      }
      const result = spawnSync(testNodeExecPath, args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BUILD_ALL_NO_PNPM: "1",
          OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
          OPENCLAW_BUILD_TIMESTAMP: "2026-08-27T00:00:00.000Z",
          GIT_COMMIT: "a".repeat(40),
        },
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(expectedExit);
      expect(JSON.parse(fs.readFileSync(waitsFile, "utf8"))).toEqual(expectedWaits);
      expect(inspectControlUiRootAssets(output, buildId).kind).toBe(expectedHealth);
      if (expectedOutputId) {
        const expected = buildFiles(expectedOutputId);
        expect(
          fs
            .readdirSync(output, { recursive: true, encoding: "utf8" })
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
          ["assets", ...Object.keys(expected)].map((file) => path.normalize(file)).toSorted(),
        );
        for (const [file, bytes] of Object.entries(expected)) {
          expect(fs.readFileSync(path.join(output, file))).toEqual(Buffer.from(bytes));
        }
      }
      expect(fs.readdirSync(path.join(root, "dist")).toSorted()).toEqual(
        expectedDistEntries.toSorted(),
      );
      if (seedSiblings) {
        for (const name of liveUiBuildSiblings) {
          expect(fs.readFileSync(path.join(root, "dist", name, "sentinel"), "utf8")).toBe(name);
        }
      }
      if (expectedExit === 0) {
        const calls = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const staging = calls[0].out;
        expect(path.dirname(staging)).toBe(path.join(root, "dist"));
        expect(staging).not.toBe(output);
        expect(calls).toEqual([
          {
            tool: "vite",
            out: staging,
            args: ["build", "--mode", "fixture with spaces", "--outDir", staging],
          },
          { tool: "precompressed", out: staging, args: [staging] },
          { tool: "performance", out: staging, args: ["--report-only", "--dist", staging] },
        ]);
      }
      if (expectedStderr) {
        expect(result.stderr).toContain(expectedStderr);
      }
    },
  );

  it("checks the selected staged directory with both real validators", () => {
    const root = tempDirs.make("openclaw-ui-validators-");
    const staging = path.join(root, "dist/control-ui.build-123-fixture");
    fs.mkdirSync(path.join(staging, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(staging, "index.html"),
      '<script src="./assets/index.js"></script><link href="./assets/index.css">',
    );
    for (const name of ["index.js", "index.css"]) {
      const bytes = Buffer.from("/* synthetic asset */");
      const file = path.join(staging, "assets", name);
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(`${file}.gz`, gzipSync(bytes));
      fs.writeFileSync(`${file}.br`, brotliCompressSync(bytes));
    }
    for (const [script, ...args] of [
      ["check-control-ui-precompressed-assets.mts", staging],
      ["check-control-ui-performance.mts", "--report-only", "--dist", staging],
    ] as const) {
      const result = spawnSync(testNodeExecPath, [path.resolve("scripts", script), ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each([
    { noPnpm: false, failValidator: null },
    { noPnpm: false, failValidator: "check-control-ui-precompressed-assets.mts" },
    { noPnpm: true, failValidator: "check-control-ui-performance.mts" },
  ])(
    "reports budgets and enforces asset validity without compiler children or disk caches (noPnpm=$noPnpm, failure=$failValidator)",
    ({ noPnpm, failValidator }) => {
      const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-cache-")));
      const root = path.join(tempDir, "repo");
      copyUiFixture(root);
      const modules = path.join(root, "node_modules");
      const vite = writeUiPackageBin(
        modules,
        "vite",
        'throw new Error("build must be intercepted");',
      );
      writeUiPackageBin(modules, "dompurify", "export {};\n");
      const tempRoot = path.join(tempDir, "temp");
      const cacheRoots = ["tsx", `tsx-${process.geteuid?.() ?? os.userInfo().username}`].map(
        (name) => path.join(tempRoot, name),
      );
      const accessLog = path.join(tempDir, "cache-access.log");
      const guard = path.join(tempDir, "cache-guard.cjs");
      const capture = path.join(tempDir, "capture-ui-children.cjs");
      const fixture = path.join(tempDir, "validator.mts");
      const pnpm = path.join(tempDir, "pnpm.cjs");
      const validators = [
        "check-control-ui-precompressed-assets.mts",
        "check-control-ui-performance.mts",
      ];

      try {
        for (const cacheRoot of cacheRoots) {
          fs.mkdirSync(cacheRoot, { recursive: true });
          fs.writeFileSync(path.join(cacheRoot, "0-sentinel"), "keep");
        }
        // Record before throwing: tsx catches some cache errors, so exit status alone
        // cannot prove that the loader left the cache untouched.
        fs.writeFileSync(
          guard,
          `
const fs = require("node:fs");
const path = require("node:path");
const roots = ${JSON.stringify(cacheRoots)};
if (${JSON.stringify(validators)}.includes(process.argv[2])) {
  function rejectRuntimeActivity(operation) {
    fs.appendFileSync(${JSON.stringify(accessLog)}, operation + "\\n");
    throw new Error("Unexpected validator runtime activity: " + operation);
  }
  const childProcess = require("node:child_process");
  for (const operation of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[operation] = function() { rejectRuntimeActivity(operation); };
  }
  require("node:worker_threads").Worker = function() { rejectRuntimeActivity("Worker"); };
}
function guardAccess(target, operation) {
  const resolved = path.resolve(String(target));
  if (roots.some(root => resolved === root || resolved.startsWith(root + path.sep))) {
    fs.appendFileSync(${JSON.stringify(accessLog)}, operation + "\\n");
    throw new Error("Unexpected tsx disk cache access: " + operation);
  }
}
for (const operation of ["readdirSync", "readFileSync", "writeFileSync", "openSync"]) {
  const original = fs[operation];
  fs[operation] = function(target, ...args) {
    guardAccess(target, operation);
    return original.call(this, target, ...args);
  };
}
for (const operation of ["readdir", "readFile", "writeFile", "open", "unlink", "rm", "rmdir", "access"]) {
  const original = fs.promises[operation];
  fs.promises[operation] = async function(target, ...args) {
    guardAccess(target, operation);
    return original.call(this, target, ...args);
  };
}
require("node:module").syncBuiltinESMExports();
`,
        );
        fs.writeFileSync(pnpm, 'throw new Error("build must be intercepted");\n');
        fs.writeFileSync(
          fixture,
          `
const validator: string = process.argv[2];
const reportOnly = process.argv.includes("--report-only");
console.log(JSON.stringify({ validator, reportOnly }));
process.exitCode = validator === ${JSON.stringify(failValidator)} ? 17
  : validator === "check-control-ui-performance.mts" && !reportOnly ? 1 : 0;
`,
        );
        // Run the native launcher, intercept only the build, then replay each real
        // validator command/environment with erasable TypeScript. The preload rejects
        // compiler workers and subprocesses before they can escape validator completion.
        fs.writeFileSync(
          capture,
          `
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const spawnSync = childProcess.spawnSync;
const validators = ${JSON.stringify(validators)};
assert.equal(process.env.TSX_DISABLE_CACHE, undefined);
assert.equal(process.env.npm_execpath, ${JSON.stringify(pnpm)});
childProcess.spawnSync = function(command, args, options) {
  if (args[0] === ${JSON.stringify(vite)}) {
    assert.deepEqual(args.slice(1, 3), ["build", "--outDir"]);
    assert.equal(path.dirname(args[3]), ${JSON.stringify(path.join(root, "dist"))});
    assert.equal(require("node:fs").existsSync(args[3]), true);
    return { status: 0 };
  }
  const validatorIndex = args.findIndex(arg => validators.includes(path.basename(arg)));
  if (validatorIndex === -1) throw new Error("Unexpected UI subprocess");
  const validator = path.basename(args[validatorIndex]);
  const validatorArgs = args.slice(validatorIndex + 1);
  const staging = validatorArgs.at(-1);
  assert.equal(path.dirname(staging), ${JSON.stringify(path.join(root, "dist"))});
  assert.equal(require("node:fs").existsSync(staging), true);
  assert.deepEqual(validatorArgs, validator === "check-control-ui-performance.mts" ? ["--report-only", "--dist", staging] : [staging]);
  assert.equal(options.env.TSX_DISABLE_CACHE, undefined);
  return spawnSync(command, [...args.slice(0, validatorIndex), ${JSON.stringify(fixture)}, validator, ...validatorArgs], options);
};
require("node:module").syncBuiltinESMExports();
`,
        );
        // A spread can retain NPM_EXECPATH, which wins over npm_execpath on Windows.
        const env = mergeProcessEnv([
          process.env,
          {
            TMPDIR: tempRoot,
            TMP: tempRoot,
            TEMP: tempRoot,
            XDG_CACHE_HOME: path.join(tempDir, "xdg-cache"),
            NODE_COMPILE_CACHE: path.join(tempDir, "node-cache"),
            NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
            OPENCLAW_BUILD_ALL_NO_PNPM: noPnpm ? "1" : "0",
            OPENCLAW_BUILD_TIMESTAMP: "2026-08-27T00:00:00.000Z",
            GIT_COMMIT: "a".repeat(40),
            npm_execpath: pnpm,
            TSX_DISABLE_CACHE: undefined,
            TSX_TSCONFIG_PATH: undefined,
            PNPM_CONFIG_MODULES_DIR: undefined,
            npm_config_modules_dir: undefined,
          },
        ]);

        if (!noPnpm && failValidator === null) {
          const control = spawnSync(
            testNodeExecPath,
            ["--eval", `require("node:fs").readdirSync(${JSON.stringify(cacheRoots[0])})`],
            { cwd: root, encoding: "utf8", env, timeout: 10_000 },
          );
          expect(control.error).toBeUndefined();
          expect(control.status).toBe(1);
          // Check the cache guard without starting the compiler service it protects against.
          expect(fs.readFileSync(accessLog, "utf8").trim()).toBe("readdirSync");
          fs.unlinkSync(accessLog);
        }
        const result = spawnSync(
          testNodeExecPath,
          ["--require", capture, "scripts/ui.js", "build"],
          {
            cwd: root,
            encoding: "utf8",
            env,
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(fs.existsSync(accessLog), result.stderr).toBe(false);
        expect(result.status, result.stderr).toBe(failValidator ? 17 : 0);
        const expectedValidators = failValidator
          ? validators.slice(0, validators.indexOf(failValidator) + 1)
          : validators;
        expect(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          expectedValidators.map((validator) => ({
            validator,
            reportOnly: validator === "check-control-ui-performance.mts",
          })),
        );
        for (const cacheRoot of cacheRoots) {
          expect(fs.readdirSync(cacheRoot)).toEqual(["0-sentinel"]);
          expect(fs.readFileSync(path.join(cacheRoot, "0-sentinel"), "utf8")).toBe("keep");
        }
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps the package script on the canonical UI build wrapper", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["ui:build"]).toBe("node scripts/ui.js build");
  });

  it.runIf(process.platform !== "win32").each([
    {
      label: "acknowledged SIGTERM",
      requested: "SIGTERM",
      childSignal: null,
      code: 143,
      signal: null,
    },
    {
      label: "acknowledged SIGHUP",
      requested: "SIGHUP",
      childSignal: null,
      code: 129,
      signal: null,
    },
    {
      label: "raw SIGTERM",
      requested: "SIGTERM",
      childSignal: "SIGTERM",
      code: null,
      signal: "SIGTERM",
    },
    {
      label: "raw SIGKILL",
      requested: "SIGTERM",
      childSignal: "SIGKILL",
      code: null,
      signal: "SIGKILL",
    },
  ] as const)(
    "preserves $label after UI wrapper shutdown",
    async ({ requested, childSignal, code, signal }) => {
      // Keep the release outside the disposable Vitest namespace until every
      // fixture process is confirmed stopped, including on an assertion failure.
      const tempDir = fs.mkdtempSync(
        path.join(path.dirname(os.tmpdir()), "openclaw-ui-wrapper-signals-"),
      );
      const runnerPath = path.join(tempDir, "pnpm.mjs");
      const readyFile = path.join(tempDir, "ready");
      const runnerPidFile = path.join(tempDir, "runner.pid");
      const signaledFile = path.join(tempDir, "signaled");
      const releaseFile = path.join(tempDir, "release");
      const childOutcome = childSignal
        ? `process.kill(process.pid, '${childSignal}');`
        : "setTimeout(() => process.exit(0), 25);";
      const handlerLines = ["SIGTERM", "SIGHUP"].flatMap((handledSignal) => [
        `process.once('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        childOutcome,
        "});",
      ]);
      fs.writeFileSync(
        runnerPath,
        [
          "import fs from 'node:fs';",
          ...handlerLines,
          "fs.writeFileSync(process.env.RUNNER_PID_FILE, String(process.pid));",
          "fs.writeFileSync(process.env.READY_FILE, process.argv.slice(2).join(' '));",
          "setInterval(() => { if (fs.existsSync(process.env.RELEASE_FILE)) process.exit(0); }, 20);",
        ].join("\n"),
      );
      const wrapper = spawn(testNodeExecPath, ["scripts/ui.js", "install"], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          npm_execpath: runnerPath,
          READY_FILE: readyFile,
          RUNNER_PID_FILE: runnerPidFile,
          RELEASE_FILE: releaseFile,
          SIGNALED_FILE: signaledFile,
        },
        stdio: "ignore",
      });
      await withUiProcessCleanup(wrapper, tempDir, [runnerPidFile], async () => {
        await waitFor(() => readNonEmpty(readyFile) !== null, "UI runner readiness");
        expect(fs.readFileSync(readyFile, "utf8")).toBe("install");
        const runnerPid = Number(fs.readFileSync(runnerPidFile, "utf8"));
        wrapper.kill(requested);
        const exit = await waitForExit(wrapper);
        expect(exit).toEqual({ code, signal });
        expect(fs.readFileSync(signaledFile, "utf8")).toBe(requested);
        expect(pidAlive(runnerPid), "UI wrapper returned before its child stopped").toBe(false);
      });
    },
  );

  it.runIf(process.platform !== "win32").each([false, true])(
    "keeps resistant-descendant cleanup raw with failed capture=%s",
    async (failedCapture) => {
      const tempDir = fs.mkdtempSync(
        path.join(path.dirname(os.tmpdir()), "openclaw-ui-wrapper-tree-"),
      );
      const runnerPath = path.join(tempDir, "pnpm.mjs");
      const readyFile = path.join(tempDir, "ready");
      const runnerPidFile = path.join(tempDir, "runner.pid");
      const descendantPidFile = path.join(tempDir, "descendant.pid");
      const releaseFile = path.join(tempDir, "release");
      const failedCaptureFile = path.join(tempDir, "capture-failed");
      const descendantSource = [
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid));",
        "setInterval(() => { if (fs.existsSync(process.env.RELEASE_FILE)) process.exit(0); }, 20);",
      ].join("\n");
      fs.writeFileSync(
        runnerPath,
        [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          "process.on('SIGTERM', () => process.exit(0));",
          "fs.writeFileSync(process.env.RUNNER_PID_FILE, String(process.pid));",
          "fs.writeFileSync(process.env.READY_FILE, 'ready');",
          `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
          "child.unref();",
          "setInterval(() => { if (fs.existsSync(process.env.RELEASE_FILE)) process.exit(0); }, 20);",
        ].join("\n"),
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DESCENDANT_PID_FILE: descendantPidFile,
        RUNNER_PID_FILE: runnerPidFile,
        RELEASE_FILE: releaseFile,
        npm_execpath: runnerPath,
        READY_FILE: readyFile,
      };
      if (failedCapture) {
        const bin = path.join(tempDir, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, "ps"),
          '#!/bin/sh\nprintf failed > "$PS_FAILURE_FILE"\nexit 1\n',
          { mode: 0o755 },
        );
        env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
        env.PS_FAILURE_FILE = failedCaptureFile;
      }
      const wrapper = spawn(testNodeExecPath, ["scripts/ui.js", "install"], {
        cwd: path.resolve("."),
        env,
        stdio: "ignore",
      });
      await withUiProcessCleanup(wrapper, tempDir, [runnerPidFile, descendantPidFile], async () => {
        // The descendant publishes only after its resistant handler is installed.
        await waitFor(
          () => readNonEmpty(descendantPidFile) !== null,
          "UI runner descendant readiness",
        );
        const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
        wrapper.kill("SIGTERM");
        const exit = await waitForExit(wrapper, 8_000);
        expect(exit).toEqual({ code: null, signal: failedCapture ? "SIGTERM" : "SIGKILL" });
        expect(pidAlive(descendantPid)).toBe(failedCapture);
        if (failedCapture) {
          expect(fs.readFileSync(failedCaptureFile, "utf8")).toBe("failed");
        }
      });
    },
  );
});

function pidAlive(pid: number): boolean {
  // A stopped orphan can remain unreaped after the wrapper exits on Linux.
  // Require thread extinction, not immediate removal of its PID table entry.
  return !isPidDefinitelyDead(pid);
}
