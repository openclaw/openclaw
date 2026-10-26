import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isDirectScriptExecution,
  resolveUiBuildEnvironment,
  resolvePnpmSpawnCall,
} from "../../scripts/ui.mts";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../../src/gateway/control-ui-root-assets.js";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.js";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { isPidDefinitelyDead } from "../../src/shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const testNodeExecPath = resolveTestNodeExecPath();
const procSafeRoot = fs.realpathSync(
  path.dirname(createRequire(import.meta.url).resolve("@openclaw/proc-safe/package.json")),
);
const fixtureLifetime = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixtureLifetime.cleanup();
    cleanup();
  }),
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [file, bytes] of Object.entries(files)) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
}

function copyUiFixture(root: string, extra: string[] = []): void {
  for (const file of [
    "scripts/ui.js",
    "scripts/ui.mts",
    "scripts/pnpm-runner.mts",
    "scripts/run-node-package-bin.mts",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/build-identity.mts",
    "scripts/lib/output-root-guard.mjs",
    "scripts/lib/record-shared.mjs",
    "scripts/lib/prepare-control-ui-settings.mts",
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
    ...extra,
  ]) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  const nativeModules = path.join(root, "node_modules", "@openclaw");
  fs.mkdirSync(nativeModules, { recursive: true });
  // Resolve native optional dependencies from their installed package owner.
  fs.symlinkSync(procSafeRoot, path.join(nativeModules, "proc-safe"), "junction");
  writeFiles(root, {
    "package.json": '{"type":"module"}\n',
    "scripts/generate-control-ui-validators.mts":
      'if (process.argv.at(-1) !== "--check") throw new Error("expected validator freshness check");\n',
  });
  fs.mkdirSync(path.join(root, ".git"));
  installDistArtifactScripts(root, [], { compiler: false });
}

function writeUiPackageBin(modules: string, name: string, source: string): string {
  const directory = path.join(modules, name);
  writeFiles(directory, {
    "package.json": JSON.stringify({
      name,
      type: "module",
      exports: { ".": "./entry.mjs", "./package.json": "./package.json" },
      bin: { [name]: "./entry.mjs" },
    }),
    "entry.mjs": source,
  });
  return path.join(directory, "entry.mjs");
}

const buildEnvironment = {
  OPENCLAW_BUILD_ALL_NO_PNPM: "1",
  OPENCLAW_BUILD_CACHE: "0",
  OPENCLAW_BUILD_TIMESTAMP: "2026-08-27T00:00:00.000Z",
  GIT_COMMIT: "a".repeat(40),
};
const validatorNames = [
  "check-control-ui-precompressed-assets.mts",
  "check-control-ui-performance.mts",
];

function runNode(
  root: string,
  args: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
) {
  return spawnSync(testNodeExecPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    ...options,
  });
}

function expectExit(result: ReturnType<typeof runNode>, status = 0): void {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(status);
}

function outputLines(result: ReturnType<typeof runNode>) {
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function prepareBuildFixture(root: string, extra: string[] = []) {
  copyUiFixture(root, extra);
  const modules = path.join(root, "node_modules");
  writeUiPackageBin(modules, "dompurify", "export {};\n");
  return {
    vite: (source: string) => writeUiPackageBin(modules, "vite", source),
    run: (env: NodeJS.ProcessEnv, args = ["scripts/ui.js", "build"]) =>
      runNode(root, args, { env: { ...process.env, ...buildEnvironment, ...env } }),
  };
}

function processFixture(label: string) {
  // Outside Vitest's disposable namespace: retain until every process has stopped.
  const root = fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), `openclaw-ui-${label}-`));
  const files = {
    ready: path.join(root, "ready"),
    runnerPid: path.join(root, "runner.pid"),
    descendantPid: path.join(root, "descendant.pid"),
    release: path.join(root, "release"),
    signaled: path.join(root, "signaled"),
    captureFailed: path.join(root, "capture-failed"),
  };
  const runner = path.join(root, "pnpm.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_execpath: runner,
    READY_FILE: files.ready,
    RUNNER_PID_FILE: files.runnerPid,
    DESCENDANT_PID_FILE: files.descendantPid,
    RELEASE_FILE: files.release,
    SIGNALED_FILE: files.signaled,
  };
  return { root, files, runner, env };
}

function startWrapper(env: NodeJS.ProcessEnv) {
  const wrapper = spawn(testNodeExecPath, ["scripts/ui.js", "install"], {
    cwd: path.resolve("."),
    env,
    stdio: "ignore",
  });
  return { wrapper, completion: waitForExit(wrapper) };
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

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

function fixtureReadyBeforeExit(
  file: string,
  label: string,
  completion: ReturnType<typeof waitForExit>,
): Promise<void> {
  // Socket receipts can trail wrapper exit. The fixture publishes the complete
  // file before its receipt, so that durable record decides an exit-first race.
  const verifyRecord = () => {
    if (readNonEmpty(file) === null) {
      throw new Error(`timed out waiting for ${label}`);
    }
  };
  const settled = completion.then(verifyRecord, (error: unknown) => {
    if (readNonEmpty(file) === null) {
      throw error;
    }
  });
  return Promise.race([receipts.waitFor(file, "ready"), settled]);
}

async function withUiProcessCleanup(
  wrapper: ChildProcess,
  completion: ReturnType<typeof waitForExit>,
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
  await fixtureLifetime.run(() =>
    runQaGatewayFixture(
      run,
      () => fs.writeFileSync(path.join(root, "release"), "release"),
      () => completion,
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
    ),
  );
}

describe("scripts/ui", () => {
  it.each([
    ["standalone rebuild", "a", false, true],
    ["different source revision", "b", false, false],
    ["non-release metadata for release build", "a", true, false],
  ] as const)("chooses the runtime identity for %s", (_label, revision, release, reuse) => {
    const commit = "a".repeat(40);
    const firstBuild = normalizeControlUiBuildInfo({
      version: "2026.8.1",
      commit,
      builtAt: "2026-08-14T23:00:00.000Z",
      release: false,
    });
    const env = resolveUiBuildEnvironment({
      env: release ? { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1" } : {},
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => firstBuild,
      readGitCommit: () => revision.repeat(40),
      readPackageVersion: () => "2026.8.1",
    });
    if (reuse) {
      expect(
        normalizeControlUiBuildInfo({
          version: "2026.8.1",
          commit: env.GIT_COMMIT,
          builtAt: env.OPENCLAW_BUILD_TIMESTAMP,
          buildId: env.OPENCLAW_CONTROL_UI_BUILD_ID,
        }),
      ).toMatchObject(firstBuild);
    } else {
      expect(env).toMatchObject({
        GIT_COMMIT: revision.repeat(40),
        OPENCLAW_BUILD_TIMESTAMP: "2026-08-14T23:05:00.000Z",
      });
      expect(env.OPENCLAW_CONTROL_UI_BUILD_ID).toBeUndefined();
    }
  });

  it("rejects unsafe Windows pnpm shim arguments before launch", () => {
    for (const argument of ["evil&calc", "%PATH%"]) {
      expect(() =>
        resolvePnpmSpawnCall(
          ["install", argument],
          { PATH: "" },
          { npmExecPath: "", platform: "win32" },
        ),
      ).toThrow(/unsafe windows cmd\.exe argument/i);
    }
  });

  it("detects direct execution through a junctioned script path", () => {
    const realScriptPath = path.resolve("repo/openclaw/scripts/ui.js");
    const junctionScriptPath = path.resolve("linked/openclaw/scripts/ui.js");
    const realpath = (entry: string) => (entry === junctionScriptPath ? realScriptPath : entry);

    expect(isDirectScriptExecution(junctionScriptPath, realScriptPath, realpath)).toBe(true);
  });

  it("runs build from isolated dependencies without package shims", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-ui-layout-"));
    const ui = path.join(root, "ui");
    const modules = path.join(ui, "node_modules");
    const forwarded = ["--help", "--mode", "fixture with spaces & symbols"];
    copyUiFixture(root);
    for (const name of ["vite", "dompurify"]) {
      writeUiPackageBin(
        modules,
        name,
        `console.log(JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  commit: process.env.GIT_COMMIT, timestamp: process.env.OPENCLAW_BUILD_TIMESTAMP
}));
process.exitCode = 0;\n`,
      );
    }
    const pnpm = path.join(root, "pnpm.cjs");
    fs.writeFileSync(pnpm, 'throw new Error("Installed UI tools must not need package shims");\n');
    const result = runNode(root, ["scripts/ui.js", "build", ...forwarded], {
      env: mergeProcessEnv([
        process.env,
        {
          PATH: "",
          npm_execpath: pnpm,
          ...buildEnvironment,
        },
      ]),
    });
    expectExit(result);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["build", ...forwarded],
      cwd: ui,
      commit: "a".repeat(40),
      timestamp: "2026-08-27T00:00:00.000Z",
    });
  });

  const liveUiBuildSiblings = [
    `control-ui.build-${process.pid}-live`,
    `control-ui.build-${process.pid}-live.retired`,
  ];
  it.each(["default", "explicit"])("checks source prerequisites with %s cache", (cacheRoot) => {
    // Preload module URLs must preserve spaces and URL fragment characters.
    const root = fs.realpathSync(tempDirs.make("openclaw-ui-required-cache #"));
    const build = prepareBuildFixture(root, [
      "scripts/lib/build-artifact-cache.mts",
      "scripts/lib/bundled-plugin-build-entries.mjs",
      "scripts/lib/bundled-plugin-paths.mjs",
      "scripts/lib/optional-bundled-clusters.mjs",
      "scripts/lib/root-package-bundled-plugin-excludes.mjs",
      "src/shared/non-packaged-plugin-dirs.ts",
    ]);
    fs.mkdirSync(path.join(root, "extensions"));
    const posterFonts = [
      "src/gateway/assets/session-card/Lato-Regular.ttf",
      "src/gateway/assets/session-card/InstrumentSerif-Regular.ttf",
    ];
    writeFiles(root, Object.fromEntries(posterFonts.map((font) => [font, "initial font bytes"])));
    // This fixture owns UI cache behavior; the native presenter builder is
    // exercised with real source and distribution bytes in its delivery suite.
    writeFiles(root, {
      "scripts/build-plugin-control-ui.mts": "export {};\n",
      ...Object.fromEntries(validatorNames.map((file) => [`scripts/${file}`, "export {};\n"])),
    });
    build.vite(`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function runnerImport() {
  return { module: {
    refreshControlUiBuildOutput(out) { fs.writeFileSync(path.join(out, "index.html"), "refreshed identity"); },
    resolveControlUiBuildInfo() { return {}; },
  } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[process.argv.indexOf("--outDir") + 1];
  fs.mkdirSync(out, { recursive: true });
  for (const file of ["index.html", "sw.js", ".build-inputs.json"]) fs.writeFileSync(path.join(out, file), "[]");
  console.log("fixture-bundler-ran");
}
`);
    const run = (expectedExit = 0) => {
      const result = build.run({
        BUILD_ALL_CACHE_ROOT: cacheRoot === "explicit" ? path.join(root, "cache") : undefined,
        OPENCLAW_BUILD_CACHE: "1",
        OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS: "1",
        OPENCLAW_CONTROL_UI_BUILD_ID: "cache-test",
      });
      expectExit(result, expectedExit);
      return result.stdout;
    };
    expect(run()).toContain("fixture-bundler-ran");
    const cachedHtml = path.join(
      root,
      cacheRoot === "explicit" ? "cache" : ".artifacts/build-all-cache",
      "ui_build/outputs/index.html",
    );
    const cachedSource = fs.readFileSync(cachedHtml, "utf8");
    expect(run()).toContain("reused content cache");
    expect(fs.readFileSync(path.join(root, "dist/control-ui/index.html"), "utf8")).toBe(
      "refreshed identity",
    );
    expect(fs.readFileSync(cachedHtml, "utf8")).toBe(cachedSource);
    for (const font of posterFonts) {
      fs.appendFileSync(path.join(root, font), "changed font bytes");
      expect(run()).toContain("fixture-bundler-ran");
      expect(run()).toContain("reused content cache");
    }
    const plugin = path.join(root, "extensions/new-board");
    writeFiles(plugin, {
      "package.json": JSON.stringify({
        name: "@openclaw/new-board",
        openclaw: { controlUi: "browser.ts" },
      }),
      "openclaw.plugin.json": JSON.stringify({ id: "new-board" }),
    });
    expect(run()).toContain("fixture-bundler-ran");
    const output = path.join(root, "dist/control-ui/index.html");
    const published = fs.readFileSync(output, "utf8");
    writeFiles(root, { "scripts/generate-control-ui-validators.mts": "process.exitCode = 23;\n" });
    const refused = run(23);
    expect(refused).not.toContain("fixture-bundler-ran");
    expect(refused).not.toContain("reused content cache");
    expect(fs.readFileSync(output, "utf8")).toBe(published);
  });

  it.each([
    "Vite failure with stale output",
    "success replacing stale output and cleaning dead siblings",
    "EPERM publication failure with stale output",
    "interrupted swap restored before a failed retry",
  ])("publishes only validated complete output (%s)", (scenario) => {
    const seedSiblings = scenario.startsWith("success");
    const retiredOnly = scenario.startsWith("interrupted");
    const publishDenials = scenario.startsWith("EPERM") ? 100 : 0;
    const viteExit = scenario.startsWith("Vite") || retiredOnly ? 1 : 0;
    const root = fs.realpathSync(tempDirs.make("openclaw-ui-publication-"));
    const build = prepareBuildFixture(root);
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
    writeFiles(
      retiredOnly ? path.join(root, "dist", `control-ui.build-${deadPid}-x.retired`) : output,
      buildFiles("stale-runtime"),
    );
    if (retiredOnly) {
      writeFiles(root, { [`dist/control-ui.build-${deadPid}-y/junk`]: "incomplete" });
    }
    build.vite(`
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
`);
    for (const [validator, name] of [
      ["check-control-ui-precompressed-assets.mts", "precompressed"],
      ["check-control-ui-performance.mts", "performance"],
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
process.umask(0o077);
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
    const args = ["--require", fsGuard, "scripts/ui.js", "build", "--mode", "fixture with spaces"];
    if (seedSiblings) {
      for (const name of [
        ...liveUiBuildSiblings,
        `control-ui.build-${deadPid}-dead`,
        `control-ui.build-${deadPid}-dead.retired`,
      ]) {
        writeFiles(root, { [`dist/${name}/sentinel`]: name });
      }
    }
    const result = build.run({ OPENCLAW_CONTROL_UI_BUILD_ID: buildId }, args);
    expectExit(result, seedSiblings ? 0 : 1);
    expect(JSON.parse(fs.readFileSync(waitsFile, "utf8"))).toEqual(
      publishDenials ? [100, 200, 400, 800, 1600] : [],
    );
    expect(inspectControlUiRootAssets(output, buildId).kind).toBe(seedSiblings ? "ready" : "stale");
    const expected = buildFiles(seedSiblings ? buildId : "stale-runtime");
    expect(
      listDirectoryTreeStrictSync(output)
        .map((walkEntry) => walkEntry.relativePath)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["assets", ...Object.keys(expected)].map((file) => path.normalize(file)).toSorted());
    for (const [file, bytes] of Object.entries(expected)) {
      expect(fs.readFileSync(path.join(output, file))).toEqual(Buffer.from(bytes));
    }
    expect(fs.readdirSync(path.join(root, "dist")).toSorted()).toEqual(
      ["control-ui", ...(seedSiblings ? liveUiBuildSiblings : [])].toSorted(),
    );
    if (seedSiblings) {
      for (const name of liveUiBuildSiblings) {
        expect(fs.readFileSync(path.join(root, "dist", name, "sentinel"), "utf8")).toBe(name);
      }
      if (process.platform !== "win32") {
        const published = [
          output,
          ...listDirectoryTreeStrictSync(output)
            .map((walkEntry) => walkEntry.relativePath)
            .map((entry) => path.join(output, entry)),
        ];
        for (const entry of published) {
          const stat = fs.statSync(entry);
          expect(stat.mode & 0o777, entry).toBe(stat.isDirectory() ? 0o755 : 0o644);
        }
      }
      const calls = outputLines(result);
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
    if (publishDenials) {
      expect(result.stderr).toContain(
        "Failed to publish Control UI build; previous output retained.",
      );
    }
  });

  it("checks the selected staged directory with both real validators", () => {
    const root = tempDirs.make("openclaw-ui-validators-");
    const staging = path.join(root, "dist/control-ui.build-123-fixture");
    writeFiles(staging, {
      "index.html": '<script src="./assets/index.js"></script><link href="./assets/index.css">',
      "assets/index.js": "/* synthetic asset */",
      "assets/index.css": "/* synthetic asset */",
    });
    for (const name of ["index.js", "index.css"]) {
      const bytes = Buffer.from("/* synthetic asset */");
      const file = path.join(staging, "assets", name);
      fs.writeFileSync(`${file}.gz`, gzipSync(bytes));
      fs.writeFileSync(`${file}.br`, brotliCompressSync(bytes));
    }
    for (const [script, ...args] of [
      ["check-control-ui-precompressed-assets.mts", staging],
      ["check-control-ui-performance.mts", "--report-only", "--dist", staging],
    ] as const) {
      expectExit(runNode(root, [path.resolve("scripts", script), ...args]));
    }
  });

  it.runIf(process.platform !== "win32").for([
    ["acknowledged SIGTERM", false, false, null, 143, null],
    ["raw SIGKILL", false, false, "SIGKILL", null, "SIGKILL"],
    ["resistant descendant", true, false, null, null, "SIGKILL"],
    ["failed descendant capture", true, true, null, null, "SIGTERM"],
  ] as const)(
    "preserves %s after UI wrapper shutdown",
    async (
      [_label, descendant, failedCapture, childSignal, code, signal],
      { signal: testSignal },
    ) => {
      const { root, files, runner, env } = processFixture("wrapper-signals");
      const keepAlive =
        "setInterval(() => { if (fs.existsSync(process.env.RELEASE_FILE)) process.exit(0); }, 20);";
      const descendantSource = [
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(receipts.endpoint),
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid));",
        "sendReceipt(process.env.DESCENDANT_PID_FILE, 'ready');",
        keepAlive,
      ].join("\n");
      const childOutcome = childSignal
        ? `process.kill(process.pid, '${childSignal}');`
        : "setTimeout(() => process.exit(0), 25);";
      const handlerLines = descendant
        ? ["process.on('SIGTERM', () => process.exit(0));"]
        : ["SIGTERM", "SIGHUP"].flatMap((handledSignal) => [
            `process.once('${handledSignal}', () => {`,
            `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
            childOutcome,
            "});",
          ]);
      fs.writeFileSync(
        runner,
        [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          ...(descendant ? [] : [fixtureReceiptClientSource(receipts.endpoint)]),
          ...handlerLines,
          "fs.writeFileSync(process.env.RUNNER_PID_FILE, String(process.pid));",
          ...(descendant
            ? ["fs.writeFileSync(process.env.READY_FILE, 'ready');"]
            : [
                "fs.writeFileSync(process.env.READY_FILE, process.argv.slice(2).join(' '));",
                "sendReceipt(process.env.READY_FILE, 'ready');",
              ]),
          ...(descendant
            ? [
                `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
                "child.unref();",
              ]
            : []),
          keepAlive,
        ].join("\n"),
      );
      if (failedCapture) {
        const bin = path.join(root, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, "ps"),
          '#!/bin/sh\nprintf failed > "$PS_FAILURE_FILE"\nexit 1\n',
          { mode: 0o755 },
        );
        env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
        env.PS_FAILURE_FILE = files.captureFailed;
      }
      const { wrapper, completion } = startWrapper(env);
      await withUiProcessCleanup(
        wrapper,
        completion,
        root,
        descendant ? [files.runnerPid, files.descendantPid] : [files.runnerPid],
        async () => {
          // The descendant publishes only after its resistant handler is installed.
          const ready = descendant ? files.descendantPid : files.ready;
          await withinTest(
            fixtureReadyBeforeExit(ready, "UI runner readiness", completion),
            testSignal,
          );
          const watchedPid = Number(
            fs.readFileSync(descendant ? files.descendantPid : files.runnerPid, "utf8"),
          );
          wrapper.kill("SIGTERM");
          expect(await withinTest(completion, testSignal)).toEqual({ code, signal });
          expect(pidAlive(watchedPid), "UI wrapper returned before its child stopped").toBe(
            failedCapture,
          );
          if (!descendant) {
            expect(fs.readFileSync(files.ready, "utf8")).toBe("install");
            expect(fs.readFileSync(files.signaled, "utf8")).toBe("SIGTERM");
          }
          if (failedCapture) {
            expect(fs.readFileSync(files.captureFailed, "utf8")).toBe("failed");
          }
        },
      );
    },
  );
});

function pidAlive(pid: number): boolean {
  // A stopped orphan can remain unreaped after the wrapper exits on Linux.
  // Require thread extinction, not immediate removal of its PID table entry.
  return !isPidDefinitelyDead(pid);
}
