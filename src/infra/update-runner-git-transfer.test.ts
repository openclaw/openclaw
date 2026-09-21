import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitNullConfigPath } from "./git-exec.js";
import {
  classifyPartialCloneGitFailure,
  withGitTargetInspectionRoot,
} from "./update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type { CommandRunner, RunStepOptions, UpdateStepResult } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("rejects incomplete target inspection output even when Git exits zero", async () => {
  const runCommand: CommandRunner = async (argv) => ({
    code: 0,
    stdout: "a".repeat(40),
    stderr: "",
    ...(argv.includes("for-each-ref") ? { killed: true, termination: "signal" as const } : {}),
  });
  await expect(
    withGitTargetInspectionRoot(
      {
        root: temporary.make("incomplete-git-inspection-"),
        runCommand,
        timeoutMs: 1_000,
        onWarning: () => {},
      },
      async () => {},
    ),
  ).rejects.toThrow("Git target inspection for-each-ref failed");
});

it.each([
  { state: "partial-clone", expected: "promised objects in this partial clone" },
  { state: "unverified", expected: "did not verify repository corruption" },
  { state: "corrupt", expected: "verified repository corruption" },
])(
  "classifies Git's unverified corruption claim from repository evidence ($state)",
  async ({ state, expected }) => {
    const stderr =
      "fatal: object is in the commit graph file but not in the object database. This is probably due to repo corruption.";
    const runCommand: CommandRunner = async (argv) => {
      if (argv.includes("--get-regexp")) {
        return {
          code: state === "partial-clone" ? 0 : 1,
          stdout: state === "partial-clone" ? "remote.origin.promisor true\n" : "",
          stderr: "",
        };
      }
      return {
        code: state === "corrupt" ? 1 : 0,
        stdout: "",
        stderr: state === "corrupt" ? "missing blob 0123456789abcdef" : "",
      };
    };
    const result = await classifyPartialCloneGitFailure({
      result: { code: 128, stdout: "", stderr },
      root: "/partial-clone",
      runCommand,
      timeoutMs: 1_000,
    });
    expect(result.stderr).toContain(expected);
    if (state === "partial-clone") {
      expect(result.stderr).not.toContain("repo corruption");
      expect(result.stderr).toContain("sed -n 's/^?//p'");
    }
  },
);

it("uses the installed checkout runner for partial-clone classification", async () => {
  const results: UpdateStepResult[] = [];
  const inspectionRunCommand: CommandRunner = async () => ({
    code: 128,
    stdout: "",
    stderr:
      "fatal: object is in the commit graph file but not in the object database. " +
      "This is probably due to repo corruption.",
  });
  let installedConfigProbed = false;
  const installedRunCommand: CommandRunner = async (argv) => {
    installedConfigProbed = argv.includes("--get-regexp");
    return {
      code: 0,
      stdout: "remote.origin.promisor true\n",
      stderr: "",
    };
  };

  const transfer = await prepareGitCandidateTransfer({
    candidateSha: "candidate",
    beforeSha: null,
    installedRoot: "/installed",
    installedRunCommand,
    probeTimeoutMs: 1_000,
    step: {
      runCommand: inspectionRunCommand,
      cwd: "/inspection",
      argv: [],
      name: "transfer proof",
      timeoutMs: 1_000,
      stepIndex: 0,
      totalSteps: 1,
      results,
    },
  });

  expect(transfer).toBeUndefined();
  expect(installedConfigProbed).toBe(true);
  expect(results.at(-1)?.stderrTail).toContain("promised objects in this partial clone");
});

// Windows forcibly terminates children instead of delivering the handled POSIX signal.
it
  .skipIf(process.platform === "win32")
  .each([
    "none",
    "inventory",
    "missing-pack",
    "large-pack",
    "retry",
    "missing-before",
    "legacy-git",
    "configured-limit",
  ] as const)("transfers Git objects without buffering the pack (scenario=%s)", async (failure) => {
  const overflow = failure === "inventory";
  const missingPack = failure === "missing-pack";
  const largePack = failure === "large-pack";
  const root = temporary.make("git-transfer-bounds-");
  const source = path.join(root, "source");
  const install = path.join(root, "install");
  fs.mkdirSync(source);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 15_000,
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Transfer fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  const baseBytes = Buffer.concat(
    Array.from({ length: 4096 }, (_, index) =>
      createHash("sha256").update(`base:${index}`).digest(),
    ),
  );
  fs.writeFileSync(path.join(source, "base"), baseBytes);
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  const beforeSha = await git(source, "rev-parse", "HEAD");
  await git(source, "config", "uploadpack.allowFilter", "true");
  await git(
    root,
    "clone",
    ...(failure === "missing-before"
      ? ["--filter=blob:none", "--no-checkout", `file://${source}`, install]
      : [source, install]),
  );
  if (failure === "missing-before") {
    const missing = await runCommandWithTimeout(
      ["git", "--no-lazy-fetch", "-C", install, "cat-file", "-e", `${beforeSha}:base`],
      { timeoutMs: 15_000, env },
    );
    expect(missing.code).not.toBe(0);
  }
  for (let index = 0; index < 250; index++) {
    const bytes = Buffer.concat(
      Array.from({ length: failure === "configured-limit" ? 320 : 8 }, (_, block) =>
        createHash("sha256").update(`${index}:${block}`).digest(),
      ),
    );
    fs.writeFileSync(path.join(source, `object-${index}`), bytes);
  }
  if (largePack) {
    // Uncompressed Git objects keep this sparse fixture above the old pack cap.
    await git(source, "config", "core.compression", "0");
    const payload = path.join(source, "large-payload");
    fs.writeFileSync(payload, "");
    fs.truncateSync(payload, 257 * 1024 * 1024);
  }
  await git(source, "add", ".");
  await git(source, "commit", "-m", "candidate");
  const candidateSha = await git(source, "rev-parse", "HEAD");
  if (failure === "configured-limit") {
    await git(source, "config", "pack.packSizeLimit", "1m");
  }
  const results: UpdateStepResult[] = [];
  let inventoryBytes = 0;
  let packBytes = 0;
  let boundedExitObserved = false;
  let historyInventoryAllowsMissingObjects = false;
  const runCommand: CommandRunner = async (argv, options) => {
    if (argv.includes("rev-list") && argv.includes(candidateSha)) {
      historyInventoryAllowsMissingObjects = argv.includes("--missing=allow-any");
    }
    if (failure === "legacy-git" && argv.includes("--no-lazy-fetch") && argv.includes("version")) {
      return { code: 129, stdout: "", stderr: "unknown option: --no-lazy-fetch" };
    }
    if (overflow && argv.includes("rev-list")) {
      // The child emits real Git output and handles termination with exit zero.
      // This is legal process behavior; exit status alone cannot admit its tail.
      const script = `const { spawnSync } = require("node:child_process");
        process.on("SIGTERM", () => process.exit(0));
        const result = spawnSync(process.argv[1], process.argv.slice(2), { encoding: "utf8" });
        if (result.status !== 0) process.exit(result.status ?? 1);
        process.stdout.write(result.stdout); setInterval(() => {}, 1000);`;
      const result = await runCommandWithTimeout([process.execPath, "-e", script, ...argv], {
        ...options,
        env,
        maxOutputBytes: 41 * 12,
      });
      expect(result.code).toBe(0);
      expect(result.outputLimitExceeded).toBe(true);
      boundedExitObserved = true;
      return result;
    }
    if (argv.includes("pack-objects")) {
      inventoryBytes = Buffer.byteLength(options.input as string);
    }
    if (argv.includes("index-pack")) {
      expect(options.input).toBeUndefined();
      expect(options.stdinFileDescriptor).toBeTypeOf("number");
      packBytes = fs.fstatSync(options.stdinFileDescriptor!).size;
    }
    const result = await runCommandWithTimeout(argv, { ...options, env });
    if (missingPack && argv.includes("pack-objects") && result.code === 0) {
      fs.unlinkSync(`${argv.at(-1)}-${result.stdout.trim()}.pack`);
    }
    return result;
  };
  const step = (cwd: string): RunStepOptions => ({
    runCommand,
    cwd,
    argv: [],
    name: "transfer proof",
    timeoutMs: 15_000,
    stepIndex: 0,
    totalSteps: 1,
    results,
  });
  const initialTransfer = await prepareGitCandidateTransfer({
    candidateSha,
    beforeSha,
    installedRoot: install,
    installedRunCommand: runCommand,
    probeTimeoutMs: 15_000,
    step: step(source),
  });
  let transfer = initialTransfer;
  expect(historyInventoryAllowsMissingObjects).toBe(true);
  if (overflow || missingPack) {
    expect(transfer).toBeUndefined();
    if (overflow) {
      expect(boundedExitObserved).toBe(true);
      expect(inventoryBytes).toBe(0);
    } else {
      expect(results).toContainEqual(
        expect.objectContaining({
          exitCode: 1,
          name: "git-update-pack-read",
          stderrTail: expect.stringContaining("Cannot stage the Git update pack"),
        }),
      );
    }
    expect(await git(install, "rev-parse", "HEAD")).toBe(beforeSha);
    return;
  }
  expect(transfer, JSON.stringify(results.filter((entry) => entry.exitCode !== 0))).toBeDefined();
  if (transfer?.status !== "ok") {
    throw new Error("Git transfer preparation failed");
  }
  await using admittedTransfer = transfer;
  expect(inventoryBytes).toBeGreaterThan(8000);
  if (failure === "none") {
    // The pinned descriptor survives removal of the staging pathname.
    const packName = fs.readdirSync(source).find((name) => name.endsWith(".pack"))!;
    fs.unlinkSync(path.join(source, packName));
  }
  expect(await admittedTransfer.importInto(step(install))).toBe(true);
  expect(packBytes).toBeGreaterThan(8000);
  if (largePack) {
    expect(packBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(results).toContainEqual(
      expect.objectContaining({
        exitCode: 0,
        warnings: [expect.stringContaining("Large Git update pack")],
      }),
    );
  }
  if (failure === "none") {
    expect(packBytes).toBeLessThan(baseBytes.length);
  }
  if (failure === "missing-before" || failure === "legacy-git") {
    expect(packBytes).toBeGreaterThan(baseBytes.length);
  }
  if (failure === "retry") {
    await transfer!.cleanup(step(install));
    const inspection = path.join(root, "inspection.git");
    await git(root, "clone", "--mirror", "--shared", install, inspection);
    await git(inspection, "update-ref", "refs/heads/candidate", candidateSha);
    const retryTransfer = await prepareGitCandidateTransfer({
      candidateSha,
      beforeSha,
      installedRoot: install,
      installedRunCommand: runCommand,
      probeTimeoutMs: 15_000,
      step: step(inspection),
    });
    transfer = retryTransfer;
    expect(transfer, JSON.stringify(results.filter((entry) => entry.exitCode !== 0))).toBeDefined();
    if (transfer?.status !== "ok") {
      throw new Error("Git transfer retry preparation failed");
    }
    await using admittedRetryTransfer = transfer;
    expect(await admittedRetryTransfer.importInto(step(install))).toBe(true);
    await git(install, "repack", "-a", "-d");
  }
  await git(install, "checkout", "--detach", candidateSha);
  await transfer!.cleanup(step(install));
  if (failure === "configured-limit") {
    expect(packBytes).toBeGreaterThan(1024 * 1024);
    expect(await git(source, "config", "pack.packSizeLimit")).toBe("1m");
  }
  if (largePack) {
    expect(fs.statSync(path.join(install, "large-payload")).size).toBe(257 * 1024 * 1024);
    expect(await git(install, "rev-parse", "HEAD:large-payload")).toBe(
      await git(source, "rev-parse", "HEAD:large-payload"),
    );
  }
  expect(fs.readFileSync(path.join(install, "base"))).toEqual(baseBytes);
  for (let index = 0; index < 250; index++) {
    expect(fs.readFileSync(path.join(install, `object-${index}`))).toEqual(
      fs.readFileSync(path.join(source, `object-${index}`)),
    );
  }
});
