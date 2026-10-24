import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitNullConfigPath } from "./git-exec.js";
import { withGitTargetInspectionRoot } from "./update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const commandResult = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr });
const keepFiles = (root: string) =>
  fs
    .readdirSync(path.join(root, ".git", "objects", "pack"))
    .filter((name) => name.endsWith(".keep"));
const expectStep = (results: UpdateStepResult[], expected: Partial<UpdateStepResult>) =>
  expect(results).toContainEqual(expect.objectContaining(expected));

function transferStep(
  runCommand: CommandRunner,
  results: UpdateStepResult[],
  cwd: string,
  timeoutMs: number,
): RunStepOptions {
  return {
    runCommand,
    results,
    cwd,
    timeoutMs,
    argv: [],
    name: "transfer proof",
    stepIndex: 0,
    totalSteps: 1,
  };
}

function payload(prefix: string, blocks: number) {
  return Buffer.concat(
    Array.from({ length: blocks }, (_, block) =>
      createHash("sha256").update(`${prefix}:${block}`).digest(),
    ),
  );
}

it("rejects incomplete target inspection output even when Git exits zero", async () => {
  const runCommand: CommandRunner = async (argv) => ({
    ...commandResult(0, "a".repeat(40)),
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
  { state: "unverified", expected: "did not verify repository corruption" },
  { state: "corrupt", expected: "verified repository corruption" },
  { state: "promisor", expected: "promised objects in this partial clone" },
])(
  "classifies transfer failures using installed repository evidence ($state)",
  async ({ state, expected }) => {
    const results: UpdateStepResult[] = [];
    const inspectionRunCommand: CommandRunner = async () =>
      commandResult(
        128,
        "",
        "fatal: object is in the commit graph file but not in the object database. " +
          "This is probably due to repo corruption.",
      );
    let installedConfigProbed = false;
    const installedRunCommand: CommandRunner = async (argv) => {
      if (argv.includes("--get-regexp")) {
        installedConfigProbed = true;
        return commandResult(
          state === "promisor" ? 0 : 1,
          state === "promisor" ? "remote.origin.promisor true\n" : "",
        );
      }
      return commandResult(
        state === "corrupt" ? 1 : 0,
        "",
        state === "corrupt" ? "missing blob 0123456789abcdef" : "",
      );
    };

    const transfer = await prepareGitCandidateTransfer({
      candidateSha: "candidate",
      beforeSha: null,
      installedRoot: "/installed",
      installedRunCommand,
      probeTimeoutMs: 1_000,
      step: transferStep(inspectionRunCommand, results, "/inspection", 1_000),
    });

    expect(transfer).toBeUndefined();
    expect(installedConfigProbed).toBe(true);
    expect(results.at(-1)?.stderrTail).toContain(expected);
    if (state === "promisor") {
      expect(results.at(-1)?.stderrTail).not.toContain("repo corruption");
      expect(results.at(-1)?.stderrTail).toContain("sed -n 's/^?//p'");
    }
  },
);

// Windows forcibly terminates children instead of delivering the handled POSIX signal.
it
  .skipIf(process.platform === "win32")
  .each([
    "none",
    "inventory",
    "inventory-closed",
    "missing-pack",
    "large-pack",
    "retry",
    "missing-before",
    "legacy-git",
    "configured-limit",
    "cleanup-uncertain",
    "cleanup-io",
  ] as const)("transfers Git objects without buffering the pack (scenario=%s)", async (failure) => {
  const overflow = failure === "inventory" || failure === "inventory-closed";
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
  const commandOptions = { timeoutMs: 15_000, env };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], commandOptions);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const sourceGit = (...args: string[]) => git(source, ...args);
  const write = (name: string, data: string | Buffer) =>
    fs.writeFileSync(path.join(source, name), data);
  const commit = async (message: string) => {
    await sourceGit("add", ".");
    await sourceGit("commit", "-m", message);
    return sourceGit("rev-parse", "HEAD");
  };
  await sourceGit("init", "-b", "main");
  await sourceGit("config", "user.name", "Transfer fixture");
  await sourceGit("config", "user.email", "fixture@example.invalid");
  const baseBytes = payload("base", 4096);
  write("base", baseBytes);
  const beforeSha = await commit("base");
  await sourceGit("config", "uploadpack.allowFilter", "true");
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
      commandOptions,
    );
    expect(missing.code).not.toBe(0);
  }
  for (let index = 0; index < 250; index++) {
    write(`object-${index}`, payload(String(index), failure === "configured-limit" ? 320 : 8));
  }
  if (largePack) {
    // Uncompressed Git objects keep this sparse fixture above the old pack cap.
    await sourceGit("config", "core.compression", "0");
    write("large-payload", "");
    fs.truncateSync(path.join(source, "large-payload"), 257 * 1024 * 1024);
  }
  const candidateSha = await commit("candidate");
  if (failure === "configured-limit") {
    await sourceGit("config", "pack.packSizeLimit", "1m");
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
      return commandResult(129, "", "unknown option: --no-lazy-fetch");
    }
    if (overflow && argv.includes("rev-list") && argv.includes(candidateSha)) {
      if (failure === "inventory-closed") {
        const result = await runCommandWithTimeout(argv, {
          ...options,
          env,
          maxOutputBytes: 1024 * 1024,
          terminateOnOutputLimit: false,
        });
        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeGreaterThan(41 * 12);
        boundedExitObserved = true;
        // A bounded transport may report incomplete output after normal child closure.
        return { ...result, stdout: result.stdout.slice(0, 41 * 12), outputLimitExceeded: true };
      }
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
      expect(result).toMatchObject({ code: 0, outputLimitExceeded: true });
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
  const step = (cwd: string) => transferStep(runCommand, results, cwd, 15_000);
  const prepare = (cwd: string) =>
    prepareGitCandidateTransfer({
      candidateSha,
      beforeSha,
      installedRoot: install,
      installedRunCommand: runCommand,
      probeTimeoutMs: 15_000,
      step: step(cwd),
    });
  let transfer = await prepare(source);
  expect(historyInventoryAllowsMissingObjects).toBe(true);
  if (overflow || missingPack) {
    expect(transfer).toBeUndefined();
    if (overflow) {
      expect(boundedExitObserved).toBe(true);
      expect(inventoryBytes).toBe(0);
    } else {
      expectStep(results, {
        exitCode: 1,
        name: "git-update-pack-read",
        stderrTail: expect.stringContaining("Cannot stage the Git update pack"),
      });
    }
    expect(await git(install, "rev-parse", "HEAD")).toBe(beforeSha);
    return;
  }
  assert(
    transfer?.status === "ok",
    JSON.stringify(results.filter((entry) => entry.exitCode !== 0)),
  );
  await using admitted = transfer;
  expect(inventoryBytes).toBeGreaterThan(8000);
  if (failure === "none") {
    // The pinned descriptor survives removal of the staging pathname.
    const packName = fs.readdirSync(source).find((name) => name.endsWith(".pack"))!;
    fs.unlinkSync(path.join(source, packName));
  }
  expect(await admitted.importInto(step(install))).toBe(true);
  expect(packBytes).toBeGreaterThan(8000);
  if (largePack) {
    expect(packBytes).toBeGreaterThan(256 * 1024 * 1024);
    expectStep(results, {
      exitCode: 0,
      warnings: [expect.stringContaining("Large Git update pack")],
    });
  }
  if (failure === "none") {
    expect(packBytes).toBeLessThan(baseBytes.length);
  }
  if (failure === "missing-before" || failure === "legacy-git") {
    expect(packBytes).toBeGreaterThan(baseBytes.length);
  }
  if (failure === "cleanup-uncertain" || failure === "cleanup-io") {
    const error =
      failure === "cleanup-uncertain"
        ? new Error("Git cleanup did not join", { cause: new CommandProcessCleanupError() })
        : Object.assign(new Error("Git cleanup probe denied"), { code: "EACCES" });
    const recorded = results.length;
    const retained = keepFiles(install);
    expect(retained).toHaveLength(1);
    const cleanup = admitted.cleanup({
      ...step(install),
      runCommand: async () => {
        throw error;
      },
    });
    if (failure === "cleanup-uncertain") {
      await expect(cleanup).rejects.toBe(error);
      expect(results.slice(recorded)).toEqual([]);
    } else {
      await expect(cleanup).resolves.toBeUndefined();
      const advisory = {
        kind: "recoverable-maintenance",
        message: expect.stringContaining(error.message),
      };
      expect(results.slice(recorded)).toMatchObject([
        { name: "git-update-pack-cleanup", advisory },
      ]);
    }
    expect(keepFiles(install)).toEqual(retained);
  }
  if (failure === "retry") {
    await transfer!.cleanup(step(install));
    const inspection = path.join(root, "inspection.git");
    await git(root, "clone", "--mirror", "--shared", install, inspection);
    await git(inspection, "update-ref", "refs/heads/candidate", candidateSha);
    transfer = await prepare(inspection);
    assert(
      transfer?.status === "ok",
      JSON.stringify(results.filter((entry) => entry.exitCode !== 0)),
    );
    await using admittedRetryTransfer = transfer;
    expect(await admittedRetryTransfer.importInto(step(install))).toBe(true);
    await git(install, "repack", "-a", "-d");
  }
  await git(install, "checkout", "--detach", candidateSha);
  await transfer!.cleanup(step(install));
  if (failure === "cleanup-uncertain" || failure === "cleanup-io") {
    expect(keepFiles(install)).toEqual([]);
  }
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
