import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  initializeNodeWorkerGitWorkspace,
  prepareNodeWorkerGitResult,
} from "./node-worker-workspace-git.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("node workspace Git creation", () => {
  it.each(["win32", "linux"])("owns long-path configuration on %s", async (platform) => {
    const root = tempDirs.make("node-workspace-git-");
    const workspaceDir = path.join(root, "workspace");
    const packPath = path.join(root, "base.pack");
    await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
    await fs.writeFile(packPath, "synthetic pack consumed by the process boundary");
    vi.stubGlobal("process", { ...process, platform });
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "NUL");
    vi.stubEnv("GIT_CONFIG_KEY_1", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_1", "false");
    const baseCommit = "a".repeat(40);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) =>
      createCommandResult({ stdout: argv.includes("rev-parse") ? `${baseCommit}\n` : "" }),
    );
    vi.mocked(runExec).mockResolvedValue({ stdout: "pack", stderr: "" });

    await initializeNodeWorkerGitWorkspace({
      workspaceDir,
      manifestHome: root,
      packPath,
      baseCommit,
      entries: [],
    });

    const prefix = platform === "win32" ? ["-c", "core.longpaths=true"] : [];
    expect(vi.mocked(runCommandWithTimeout).mock.calls.map(([argv]) => argv)).toContainEqual([
      "git",
      ...prefix,
      "-C",
      workspaceDir,
      "init",
      "--quiet",
      "--object-format=sha1",
      ".",
    ]);
    const configuration = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.filter(([argv]) => argv.includes("config"));
    expect(configuration.map(([argv]) => argv)).toEqual(
      platform === "win32"
        ? [["git", ...prefix, "-C", workspaceDir, "config", "--local", "core.longpaths", "true"]]
        : [],
    );
    expect(runExec).toHaveBeenCalledOnce();
    const [command, args, commandOptions] = vi.mocked(runExec).mock.calls[0]!;
    expect([command, args]).toEqual([
      "git",
      [...prefix, "-C", workspaceDir, "index-pack", "--stdin"],
    ]);
    if (!commandOptions || typeof commandOptions === "number") {
      throw new Error("Git pack import requires file descriptor options");
    }
    expect(commandOptions.stdinFileDescriptor).toEqual(expect.any(Number));
    const preserved = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "NUL",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    };
    expect(
      Object.fromEntries(Object.keys(preserved).map((key) => [key, commandOptions.baseEnv?.[key]])),
    ).toEqual(preserved);
  });
});

it("captures Git history through its declared entry and retains the upload framing", async () => {
  const root = tempDirs.make("node-workspace-history-entry-");
  const controller = new AbortController();
  const history = {
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    descendsFromBase: true,
  };
  vi.mocked(runCommandWithTimeout).mockResolvedValue(
    createCommandResult({ stdout: JSON.stringify(history) }),
  );
  const packPath = path.join(root, "history.pack");
  const result = await prepareNodeWorkerGitResult({
    resultVersion: 2,
    workspaceDir: root,
    manifestHome: root,
    baseCommit: history.baseCommit,
    packPath,
    signal: controller.signal,
  });
  expect(runCommandWithTimeout).toHaveBeenCalledWith(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("nodeWorkspaceGitHistory")),
      root,
      history.baseCommit,
      packPath,
    ],
    expect.objectContaining({
      cwd: root,
      signal: controller.signal,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 128 * 1024,
      maxCombinedOutputBytes: 256 * 1024,
      baseEnv: expect.objectContaining({ HOME: root, GIT_TERMINAL_PROMPT: "0" }),
    }),
  );
  if (!result) {
    throw new Error("Version-two history must produce its upload trailer");
  }
  const chunks: Buffer[] = [];
  await result.write(async (chunk) => {
    chunks.push(chunk);
  });
  const trailer = Buffer.concat(chunks);
  const length = trailer.readUInt32BE(0);
  expect(JSON.parse(trailer.subarray(4, 4 + length).toString("utf8"))).toEqual(history);
  expect(trailer.readBigUInt64BE(4 + length)).toBe(0n);
  expect(result.byteLength).toBe(trailer.byteLength);
});
