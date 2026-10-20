import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isStandaloneRuntimeExecutable,
  readStandaloneRuntimeManifest,
  readStandaloneRuntimeManifestForRoot,
  resolveOpenClawCliInvocation,
  resolveOpenClawCliRespawn,
} from "../../cli-invocation.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());
const execPath = "/synthetic/node";
const entryPath = "/synthetic/openclaw.mjs";
const execArgv = ["--import", "synthetic-loader"];

function expectInvocation(
  options: Parameters<typeof resolveOpenClawCliInvocation>[0] & { args: string[] },
  prefix: string[] = [],
) {
  const expected = {
    command: options.execPath ?? process.execPath,
    args: [...prefix, ...options.args],
  };
  expect(resolveOpenClawCliInvocation(options)).toEqual(expected);
}

it("retains the selected entry and interpreter flags for a loose CLI", () => {
  const args = ["--profile", "fixture", "doctor", "--non-interactive"];
  expectInvocation({ execPath, entryPath, execArgv, args }, [...execArgv, entryPath]);
});

it("does not inherit the caller's entry for an explicit CLI command", () => {
  expectInvocation({
    execPath: "/synthetic/openclaw-wrapper",
    entryPath: null,
    execArgv: ["--inspect"],
    args: ["gateway", "restart"],
  });
});

it("uses the embedded fact for a self respawn without a script or interpreter flags", () => {
  vi.stubGlobal("__openclawStandaloneRootUrl", "file:///synthetic/runtime/");
  expectInvocation({
    entryPath: "/synthetic/runtime/openclaw.mjs",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    args: ["--profile", "fixture", "--version"],
  });
});

it("uses a renamed standalone artifact's manifest for service invocation and runtime metadata", () => {
  const root = tempDirs.make("cli-invocation-");
  const executable = path.join(root, "renamed-runtime");
  const runtime = path.join(root, "runtime");
  const writeManifest = (value: unknown) =>
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(value));
  const manifest = {
    schemaVersion: 1,
    mode: "jit",
    executable: { path: "renamed-runtime", sha256: "a".repeat(64) },
    runtime: { path: "runtime", sha256: "b".repeat(64) },
    openclaw: { version: "2026.10.3", commit: "c".repeat(40) },
    bun: { version: "1.4.3" },
  };
  writeManifest(manifest);
  // No executable bytes are needed: packaging owns hashes; planning owns the argv shape.
  expect(readStandaloneRuntimeManifest(executable)).toEqual(manifest);
  expect(readStandaloneRuntimeManifestForRoot(runtime)).toEqual(manifest);
  expect(() => readStandaloneRuntimeManifestForRoot(path.join(root, "unrelated"))).toThrow(
    "Invalid standalone",
  );
  expectInvocation({ execPath: executable, args: ["gateway"] });
  expectInvocation({
    execPath: executable,
    entryPath: path.join(runtime, "openclaw.mjs"),
    execArgv: ["--max-old-space-size=4096"],
    args: ["--profile", "fixture", "gateway", "--port", "18790"],
  });
  expect(() =>
    resolveOpenClawCliInvocation({
      execPath: executable,
      entryPath: path.join(root, "other-install", "openclaw.mjs"),
      args: ["doctor"],
    }),
  ).toThrow("cannot run another installation");
  writeManifest({ ...manifest, executable: { path: "another-runtime" } });
  expect(() => isStandaloneRuntimeExecutable(executable)).toThrow("Invalid standalone");
  writeManifest({ ...manifest, executable: { ...manifest.executable, path: "../outside" } });
  expect(() => readStandaloneRuntimeManifestForRoot(runtime)).toThrow("Invalid standalone");
  fs.writeFileSync(path.join(root, "manifest.json"), "{");
  expect(() => readStandaloneRuntimeManifest(executable)).toThrow("Invalid standalone");
});

it("keeps loose parent-bound respawn bytes identical to the former runner prefix", () => {
  const env = { KEEP: "unchanged" };
  const invocation = resolveOpenClawCliRespawn({
    execPath,
    entryPath,
    execArgv: ["--no-warnings", ...execArgv],
    args: ["doctor", "--fix"],
    env,
  });
  // Fixed bytes protect the self-removing preload, ordering, and inherited flags.
  const source = `
  globalThis[Symbol.for("openclaw.cliRespawnParent")] = { pid: process.ppid };
  process.execArgv = process.execArgv.filter((arg, index, args) =>
    arg !== import.meta.url && !(arg === "--import" && args[index + 1] === import.meta.url));
`;
  expect(invocation).toEqual({
    command: execPath,
    args: [
      "--import",
      `data:text/javascript,${encodeURIComponent(source)}`,
      "--no-warnings",
      ...execArgv,
      entryPath,
      "doctor",
      "--fix",
    ],
    env,
  });
  expect(invocation.env).toBe(env);
});

it("keeps runtime-flag construction out of CLI spawn transports", () => {
  // These transports accept already-resolved invocations. Adding a runtime
  // prefix here bypasses the standalone/loose decision at the invocation owner.
  for (const file of ["node-runtime-recovery.mjs", "src/process/respawn-child-runner.ts"]) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(source, file).not.toMatch(
      /CLI_PARENT_BOUND_PRELOAD|["']--(?:import|require|loader)(?:=|["'])/,
    );
  }
});
