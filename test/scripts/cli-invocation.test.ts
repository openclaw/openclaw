import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isStandaloneRuntimeExecutable,
  readStandaloneRuntimeManifest,
  readStandaloneRuntimeManifestForRoot,
  resolveOpenClawCliInvocation,
} from "../../cli-invocation.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

it("retains the selected entry and interpreter flags for a loose CLI", () => {
  expect(
    resolveOpenClawCliInvocation({
      execPath: "/synthetic/node",
      entryPath: "/synthetic/openclaw.mjs",
      execArgv: ["--import", "synthetic-loader"],
      args: ["--profile", "fixture", "doctor", "--non-interactive"],
    }),
  ).toEqual({
    command: "/synthetic/node",
    args: [
      "--import",
      "synthetic-loader",
      "/synthetic/openclaw.mjs",
      "--profile",
      "fixture",
      "doctor",
      "--non-interactive",
    ],
  });
});

it("does not inherit the caller's entry for an explicit CLI command", () => {
  expect(
    resolveOpenClawCliInvocation({
      execPath: "/synthetic/openclaw-wrapper",
      entryPath: null,
      execArgv: ["--inspect"],
      args: ["gateway", "restart"],
    }),
  ).toEqual({ command: "/synthetic/openclaw-wrapper", args: ["gateway", "restart"] });
});

it("uses the embedded fact for a self respawn without a script or interpreter flags", () => {
  vi.stubGlobal("__openclawStandaloneRootUrl", "file:///synthetic/runtime/");
  expect(
    resolveOpenClawCliInvocation({
      entryPath: "/synthetic/runtime/openclaw.mjs",
      execArgv: ["--disable-warning=ExperimentalWarning"],
      args: ["--profile", "fixture", "--version"],
    }),
  ).toEqual({ command: process.execPath, args: ["--profile", "fixture", "--version"] });
});

it("uses a renamed standalone artifact's manifest for service invocation and runtime metadata", () => {
  const root = tempDirs.make("cli-invocation-");
  const executable = path.join(root, "renamed-runtime");
  const manifest = {
    schemaVersion: 1,
    mode: "jit",
    executable: { path: "renamed-runtime", sha256: "a".repeat(64) },
    runtime: { path: "runtime", sha256: "b".repeat(64) },
    openclaw: { version: "2026.10.3", commit: "c".repeat(40) },
    bun: { version: "1.4.3" },
  };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  // No executable bytes are needed: packaging owns hashes; planning owns the argv shape.
  expect(readStandaloneRuntimeManifest(executable)).toEqual(manifest);
  expect(readStandaloneRuntimeManifestForRoot(path.join(root, "runtime"))).toEqual(manifest);
  expect(() => readStandaloneRuntimeManifestForRoot(path.join(root, "unrelated"))).toThrow(
    "Invalid standalone",
  );
  expect(
    resolveOpenClawCliInvocation({
      execPath: executable,
      args: ["gateway"],
    }),
  ).toEqual({ command: executable, args: ["gateway"] });
  expect(
    resolveOpenClawCliInvocation({
      execPath: executable,
      entryPath: path.join(root, "runtime", "openclaw.mjs"),
      execArgv: ["--max-old-space-size=4096"],
      args: ["--profile", "fixture", "gateway", "--port", "18790"],
    }),
  ).toEqual({
    command: executable,
    args: ["--profile", "fixture", "gateway", "--port", "18790"],
  });
  expect(() =>
    resolveOpenClawCliInvocation({
      execPath: executable,
      entryPath: path.join(root, "other-install", "openclaw.mjs"),
      args: ["doctor"],
    }),
  ).toThrow("cannot run another installation");
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({ ...manifest, executable: { path: "another-runtime" } }),
  );
  expect(() => isStandaloneRuntimeExecutable(executable)).toThrow("Invalid standalone");
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({ ...manifest, executable: { ...manifest.executable, path: "../outside" } }),
  );
  expect(() => readStandaloneRuntimeManifestForRoot(path.join(root, "runtime"))).toThrow(
    "Invalid standalone",
  );
  fs.writeFileSync(path.join(root, "manifest.json"), "{");
  expect(() => readStandaloneRuntimeManifest(executable)).toThrow("Invalid standalone");
});
