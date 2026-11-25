import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as cli from "../../cli-invocation.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parentExecArgv = process.execArgv;
afterEach(() => {
  process.execArgv = parentExecArgv;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const execPath = "/synthetic/node";
const entryPath = "/synthetic/openclaw.mjs";
const execArgv = ["--import", "synthetic-loader"];

it.each([
  ["native source execution", undefined, undefined, [], false],
  ["loose source loader", undefined, undefined, execArgv, true],
  ["embedded executable", "file:///synthetic/runtime/", undefined, execArgv, false],
  ["standalone disk script", "file:///synthetic/runtime/", "1", execArgv, true],
] as const)("detects source loaders: %s", (_label, root, bunBeBun, argv, expected) => {
  vi.stubGlobal("__openclawStandaloneRootUrl", root);
  vi.stubEnv("BUN_BE_BUN", bunBeBun);
  vi.stubEnv("NODE_OPTIONS", "");
  process.execArgv = [...argv];
  expect(cli.runtimeHasSourceLoader()).toBe(expected);
});

function expectInvocation(
  options: Parameters<typeof cli.resolveOpenClawCliInvocation>[0] & { args: string[] },
  prefix: string[] = [],
) {
  expect(cli.resolveOpenClawCliInvocation(options)).toEqual({
    command: options.execPath ?? process.execPath,
    args: [...prefix, ...options.args],
  });
}

it.each([
  ["loose", execPath, entryPath],
  ["explicit", "/synthetic/openclaw-wrapper", null],
  ["embedded", process.execPath, "/synthetic/runtime/openclaw.mjs"],
] as const)("preserves arguments and chooses the %s CLI prefix", (mode, command, entry) => {
  if (mode === "embedded") {
    vi.stubGlobal("__openclawStandaloneRootUrl", "file:///synthetic/runtime/");
  }
  const args = ["--profile", "fixture", "doctor", "--non-interactive"];
  expectInvocation(
    { execPath: command, entryPath: entry, execArgv, args },
    mode === "loose" ? [...execArgv, entryPath] : [],
  );
});

function manifestFixture(extra = {}) {
  const root = tempDirs.make("cli-manifest-");
  const executable = path.join(root, "renamed-cli");
  const runtime = path.join(root, "runtime");
  const manifest = {
    schemaVersion: 1,
    mode: "jit",
    executable: { path: "renamed-cli", sha256: "a".repeat(64) },
    runtime: { path: "runtime", sha256: "b".repeat(64) },
    openclaw: { version: "1", commit: "c".repeat(40) },
    bun: { version: "1" },
    ...extra,
  };
  const file = path.join(root, "manifest.json");
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  write(manifest);
  return { root, executable, runtime, manifest, file, write };
}

it("projects build facts but trusts the executing image over its sidecar", () => {
  const build = {
    mode: "aot",
    openclaw: { version: "2026.10.6", commit: "a".repeat(40) },
    bun: { version: "1.4.4", revision: "compiler-revision" },
    target: { platform: "linux", arch: "arm64" },
    build: {
      id: "matching-build",
      flavor: "standard",
      pluginSetSha256: "b".repeat(64),
      moduleGraphSha256: "c".repeat(64),
    },
    plugins: { embedded: ["codex"], omitted: ["matrix"] },
    nativeModules: [
      {
        name: "sqlite",
        version: "1",
        artifacts: [],
        qualification: "unverified",
        backend: "sqlite",
      },
    ],
  };
  const { executable, file } = manifestFixture(build);
  expect(cli.getStandaloneRuntimeBuild(executable)).toMatchObject(build);
  vi.stubGlobal("__openclawStandaloneBuildInfo", build);
  fs.writeFileSync(file, "corrupted sidecar metadata");
  expect(cli.getStandaloneRuntimeBuild()).toEqual(build);
});

it("uses renamed manifests and rejects unrelated or invalid runtime metadata", () => {
  const { root, executable, runtime, manifest, file, write } = manifestFixture();
  const invalid = (read: () => unknown) => expect(read).toThrow("Invalid standalone");
  expect(cli.readStandaloneRuntimeManifest(executable)).toEqual(manifest);
  expect(cli.readStandaloneRuntimeManifestForRoot(runtime)).toEqual(manifest);
  invalid(() => cli.readStandaloneRuntimeManifestForRoot(path.join(root, "unrelated")));
  expectInvocation({ execPath: executable, args: ["gateway"] });
  expectInvocation({
    execPath: executable,
    entryPath: path.join(runtime, "openclaw.mjs"),
    execArgv: ["--max-old-space-size=4096"],
    args: ["--profile", "fixture", "gateway", "--port", "18790"],
  });
  expect(() =>
    cli.resolveOpenClawCliInvocation({
      execPath: executable,
      entryPath: path.join(root, "other-install", "openclaw.mjs"),
      args: ["doctor"],
    }),
  ).toThrow("cannot run another installation");
  write({ ...manifest, executable: { path: "another-runtime" } });
  invalid(() => cli.isStandaloneRuntimeExecutable(executable));
  write({ ...manifest, executable: { ...manifest.executable, path: "../outside" } });
  invalid(() => cli.readStandaloneRuntimeManifestForRoot(runtime));
  fs.writeFileSync(file, "{");
  invalid(() => cli.readStandaloneRuntimeManifest(executable));
});
