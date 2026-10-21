import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as runtimes from "../daemon/runtime-paths.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import * as executables from "./executable-path.js";
import { prepareGitCandidateNodeRuntime } from "./update-runner-git-node-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalVersions = process.versions;
const originalExecPath = process.execPath;
const nodePath = path.resolve("fixture", "managed-node", "node");
const oldNodePath = path.resolve("fixture", "old-node", "node");
const supported = {
  status: "supported" as const,
  version: "26.7.0",
  sqliteVersion: "3.53.0",
  nodeSharedSqlite: false,
  sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
};
let root: string;
const writeEngine = (node: string) =>
  fs.writeFile(path.join(root, "package.json"), JSON.stringify({ engines: { node } }));
const setHost = (versions: typeof process.versions, execPath = originalExecPath) => {
  Object.defineProperty(process, "versions", { value: versions });
  Object.defineProperty(process, "execPath", { value: execPath });
};

beforeEach(async () => {
  root = tempDirs.make("candidate-node-");
  await writeEngine(">=26.1.0");
  setHost({ ...originalVersions, bun: "1.4.3" });
  vi.spyOn(runtimes, "resolveSystemNodeInfo").mockResolvedValue(null);
  vi.spyOn(executables, "resolveExecutableFromPathEnv").mockImplementation((_name, directories) => {
    return directories[0] === path.dirname(nodePath) ? nodePath : oldNodePath;
  });
  vi.spyOn(runtimes, "resolveNodeRuntimeInfo").mockResolvedValue(supported);
});

afterEach(() => {
  setHost(originalVersions);
  vi.restoreAllMocks();
});

it("binds the qualified system fallback when PATH has no Node", async () => {
  vi.mocked(runtimes.resolveSystemNodeInfo).mockResolvedValue({ ...supported, path: nodePath });
  const result = await prepareGitCandidateNodeRuntime(root, {});
  expect(result.env?.PATH).toBe(path.dirname(nodePath));
  expect(runtimes.resolveNodeRuntimeInfo).not.toHaveBeenCalled();
});

it("refuses unsafe SQLite even when the candidate engine accepts the version", async () => {
  vi.mocked(runtimes.resolveNodeRuntimeInfo).mockResolvedValue({
    ...supported,
    status: "unsupported",
  });
  const result = await prepareGitCandidateNodeRuntime(root, { PATH: path.dirname(nodePath) });
  expect(result.step).toMatchObject({ name: "preflight-node-runtime", exitCode: 1 });
  expect(result.step?.stderrTail).toContain("WAL-reset-safe SQLite");
  expect(result.env).toBeUndefined();
});

it.each([
  { runtime: "node", selectedFirst: false },
  { runtime: "bun", selectedFirst: false },
  { runtime: "node", selectedFirst: true },
])(
  "preserves scoped package tools under $runtime (selected Node first: $selectedFirst)",
  async ({ runtime, selectedFirst }) => {
    vi.mocked(runtimes.resolveNodeRuntimeInfo).mockRestore();
    vi.mocked(executables.resolveExecutableFromPathEnv).mockRestore();
    const realNode = resolveTestNodeExecPath();
    await writeEngine(">=24.16.0 <25 || >=26.1.0");
    const selectedBin = path.join(root, "selected-bin");
    const shadowBin = path.join(root, "shadow-bin");
    const scopedBin = path.join(root, "scoped-bin");
    await Promise.all([selectedBin, shadowBin, scopedBin].map((bin) => fs.mkdir(bin)));
    const executable = process.platform === "win32" ? "node.exe" : "node";
    await fs.symlink(realNode, path.join(selectedBin, executable), "file");
    await fs.writeFile(path.join(shadowBin, executable), "not an executable", { mode: 0o755 });
    const manager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    await fs.writeFile(
      path.join(scopedBin, manager),
      process.platform === "win32"
        ? '@echo off\r\nnode -p "process.execPath"\r\n'
        : "#!/usr/bin/env node\nconsole.log(process.execPath);\n",
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(selectedBin, manager),
      process.platform === "win32"
        ? "@echo off\r\necho wrong-pnpm\r\n"
        : "#!/bin/sh\necho wrong-pnpm\n",
      { mode: 0o755 },
    );
    if (runtime === "node") {
      setHost({ ...originalVersions, bun: undefined }, path.join(selectedBin, executable));
    }
    const result = await prepareGitCandidateNodeRuntime(root, {
      PATH: (selectedFirst
        ? [selectedBin, scopedBin, shadowBin, selectedBin]
        : [scopedBin, shadowBin, selectedBin]
      ).join(path.delimiter),
    });
    expect(result.step).toBeUndefined();
    const observed = await runCommandWithTimeout([manager], {
      env: result.env,
      timeoutMs: 5000,
    });
    expect(observed.code).toBe(0);
    expect(observed.stdout.trim()).toBe(await fs.realpath(realNode));
  },
);

it("qualifies the actual package-tooling Node when the Node host has a custom executable name", async () => {
  setHost(
    { ...originalVersions, node: "26.7.0", bun: undefined },
    path.resolve("fixture", "node26"),
  );
  await writeEngine(">=24.16.0 <25 || >=26.1.0");
  const result = await prepareGitCandidateNodeRuntime(root, { PATH: path.dirname(nodePath) });
  expect(runtimes.resolveNodeRuntimeInfo).toHaveBeenCalledWith(nodePath, expect.any(Object));
  expect(result.env?.PATH).toBe(path.dirname(nodePath));
});
