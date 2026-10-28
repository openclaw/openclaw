import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import {
  expectRuntime,
  runFixtureGit as git,
  expectHead,
  expectFile,
  readText,
  type GitCandidateFixture,
} from "./update-runner-git-candidate.test-support.js";

const assertCurrent = () => {};

async function activateTransaction(
  { update }: GitCandidateFixture,
  options: Parameters<GitCandidateFixture["update"]>[0] = {},
  status = "ok",
) {
  let retained: PackageUpdateTransaction | undefined;
  const result = await update({
    ...options,
    onTransaction: (transaction) => {
      retained = transaction;
    },
  });
  expect(result.status).toBe(status);
  assert(retained);
  return { retained, result };
}

const completeRollback = (transaction: PackageUpdateTransaction) =>
  transaction.complete({ activationVerified: false }, assertCurrent);

async function expectGeneration(root: string, sha: string) {
  await expectHead(root, sha);
  await expectRuntime(root, sha);
}

async function expectGit(root: string, expected: string, ...args: string[]) {
  expect(await git(root, ...args)).toBe(expected);
}

function commitTree(root: string, parent: string) {
  return git(root, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "operator commit");
}

async function expectCleanupWarning(retained: PackageUpdateTransaction, paths: string[]) {
  const remove = fs.rm.bind(fs);
  const removal = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
    if (paths.some((file) => entry === file)) {
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    }
    return remove(entry, options);
  });
  try {
    const warning = await retained.complete({ activationVerified: true }, assertCurrent);
    expect(warning).toMatchObject({ advisory: { kind: "recoverable-maintenance" } });
    expect(await retained.complete({ activationVerified: true }, assertCurrent)).toBe(warning);
    return warning;
  } finally {
    removal.mockRestore();
  }
}

async function expectRetainedBackup(root: string, beforeSha: string, buildId = false) {
  const backups = (await fs.readdir(root)).filter(
    (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
  );
  if (buildId) {
    expect(backups).toHaveLength(1);
  }
  const backup = backups[0];
  assert(backup);
  expect(
    JSON.parse(await readText(path.join(root, backup, "previous", "build-info.json"))),
  ).toMatchObject({ commit: beforeSha, ...(buildId ? { buildId: beforeSha } : {}) });
}

const isBranchCheckout = (argv: string[], root: string) =>
  argv[2] === root && argv.includes("checkout") && argv.includes("-B");

async function advanceFixture(getFixture: () => GitCandidateFixture) {
  const fixture = getFixture();
  return { ...fixture, targetSha: await fixture.advanceRemote() };
}

async function expectRuntimeRetained(
  root: string,
  sha: string,
  retained: PackageUpdateTransaction,
) {
  await expectRuntime(root, sha);
  await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
}

export function registerGitActivationDoctorOutcomeTests(getFixture: () => GitCandidateFixture) {
  registerGitRetainedTransactionTests(getFixture);
  it("keeps the Git validation runtime usable through activation and failed cleanup", async () => {
    const fixture = await advanceFixture(getFixture);
    const { root, targetSha } = fixture;
    let candidateRoot: string | undefined;
    let denyCleanup = false;
    const validateRetained = async () => {
      assert(candidateRoot);
      await expectGeneration(candidateRoot, targetSha);
    };
    fixture.setRunCommand(async (argv, options) => {
      if (denyCleanup && argv.includes("worktree") && argv.includes("remove")) {
        return { code: 1, stdout: "", stderr: "candidate cleanup denied" };
      }
      return fixture.runCommand(argv, options);
    });
    const { retained, result } = await activateTransaction(fixture, {
      validateCandidate: async (directory) => {
        candidateRoot = directory;
        expect(fixture.isStopped()).toBe(false);
        await validateRetained();
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    denyCleanup = true;
    assert(candidateRoot);
    await expectCleanupWarning(retained, [path.dirname(candidateRoot), candidateRoot]);
    await validateRetained();
    await expectRuntimeRetained(root, targetSha, retained);
  });

  it("retains the activated runtime when backup cleanup fails", async () => {
    const fixture = await advanceFixture(getFixture);
    const { retained } = await activateTransaction(fixture);
    const warning = await expectCleanupWarning(retained, [retained.backupRoot]);
    expect(warning?.advisory?.message).toContain(retained.backupRoot);
    await expectRuntimeRetained(fixture.root, fixture.targetSha, retained);
  });

  it("retains the activated transaction when the Doctor entry is missing", async () => {
    const fixture = await advanceFixture(getFixture);
    const { root, beforeSha, targetSha, expectNoRuntimeStagingPaths } = fixture;
    const { result, retained } = await activateTransaction(
      fixture,
      { runGitDoctor: async () => null },
      "error",
    );
    expect(result).toMatchObject({ status: "error", reason: "doctor-entry-missing" });
    await expectGeneration(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    expect((await retained.rollback(assertCurrent)).exitCode).toBe(0);
    await completeRollback(retained);
    await expectGeneration(root, beforeSha);
    await expectNoRuntimeStagingPaths();
  });
  it.each([
    ["config-refused", "repair-requires-config-change"],
    ["requester-revoked", "requester-revoked"],
    ["doctor-zero-exit-timeout", "doctor-failed"],
    ["cleanup-uncertain", undefined],
  ] as const)(
    "uses the CLI activation Doctor and preserves its outcome: %s",
    async (outcome, reason) => {
      const fixture = await advanceFixture(getFixture);
      const { root, beforeSha, events, isStopped, targetSha, update } = fixture;
      const configChanges: UpdateDoctorConfigChange[] = [{ kind: "key", key: "agents" }];
      const cleanupError = new Error("Doctor child cleanup remains unresolved", {
        cause: new CommandProcessCleanupError(),
      });
      const runGitDoctor = async (doctorRoot: string) => {
        expect(isStopped()).toBe(true);
        await expectRuntime(doctorRoot, targetSha);
        events.push("owned-doctor");
        if (outcome === "requester-revoked") {
          throw new UpdateRequesterRevokedError();
        }
        if (outcome === "cleanup-uncertain") {
          throw cleanupError;
        }
        return {
          name: "openclaw doctor",
          command: "candidate doctor",
          cwd: doctorRoot,
          durationMs: 1,
          exitCode: outcome === "doctor-zero-exit-timeout" ? 0 : 1,
          ...(outcome === "doctor-zero-exit-timeout" ? { termination: "timeout" as const } : {}),
          configChanges,
          ...(outcome === "config-refused"
            ? {
                configWriteRefusal: {
                  reason: "include-ownership",
                  message: "An included file owns the pending config change.",
                  keys: ["agents"],
                },
              }
            : {}),
        };
      };

      const running = update({ runGitDoctor });
      const result = outcome === "cleanup-uncertain" ? undefined : await running;
      if (!result) {
        await expect(running).rejects.toBe(cleanupError);
      }
      expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
      await expectGeneration(root, targetSha);
      if (!result) {
        await expectRetainedBackup(root, beforeSha, true);
        return;
      }
      expect(result).toMatchObject({ status: "error", reason });
      await fixture.expectNoRuntimeStagingPaths();
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        reason: "state-migration-started",
      });
      if (outcome !== "requester-revoked") {
        expect(result.steps.find((step) => step.name === "openclaw doctor")?.configChanges).toEqual(
          configChanges,
        );
      }
    },
  );
}

function registerGitRetainedTransactionTests(getFixture: () => GitCandidateFixture) {
  it.each([
    ["source check", "tracked"],
    ["checkout", "tracked"],
    ["source restore", "untracked"],
    ["before checkout", "tracked"],
    ["before source restore", "tracked"],
    ["before source restore", "staged"],
    ["before source restore", "staged-unrelated"],
  ] as const)("retained rollback preserves %s await edits (%s)", async (phase, kind) => {
    const fixture = await advanceFixture(getFixture);
    const { root, beforeSha, targetSha, runCommand, setRunCommand } = fixture;
    const relative =
      kind === "untracked"
        ? "operator-edit.txt"
        : kind === "staged-unrelated"
          ? "openclaw.mjs"
          : "candidate.txt";
    const file = path.join(root, relative);
    const edit = "preserve this operator edit\n";
    let rollingBack = false;
    let edited = false;
    setRunCommand(async (argv, options) => {
      const matches =
        rollingBack &&
        !edited &&
        argv[0] === "git" &&
        argv[2] === root &&
        ((phase === "source check" && argv.includes("--abbrev-ref")) ||
          ((phase === "checkout" || phase === "before checkout") && argv.includes("checkout")) ||
          ((phase === "source restore" || phase === "before source restore") &&
            argv.includes("checkout") &&
            argv.includes("-B") &&
            argv.at(-1) === beforeSha));
      if (matches && phase.startsWith("before ")) {
        await fs.writeFile(file, edit);
        if (kind === "staged" || kind === "staged-unrelated") {
          await git(root, "add", relative);
          if (kind === "staged-unrelated") {
            await fs.writeFile(file, `${edit}unstaged content\n`);
          }
        }
        edited = true;
      }
      const result = await runCommand(argv, options);
      if (matches && !phase.startsWith("before ")) {
        expect(result.code).toBe(0);
        // The child has completed, but the rollback owner has not resumed yet.
        await fs.writeFile(file, edit);
        edited = true;
      }
      return result;
    });
    const { retained } = await activateTransaction(fixture);
    rollingBack = true;
    await expect(retained.rollback(assertCurrent)).rejects.toBeInstanceOf(Error);
    expect(edited).toBe(true);
    expect(await readText(file).catch(() => undefined)).toBe(
      kind === "staged-unrelated" ? `${edit}unstaged content\n` : edit,
    );
    if (kind === "staged" || kind === "staged-unrelated") {
      await expectGit(root, edit.trim(), "show", `:${relative}`);
    }
    if (kind === "staged-unrelated") {
      expect(await git(root, "status", "--short")).toContain("MM openclaw.mjs");
    }
    await expect(completeRollback(retained)).rejects.toThrow();
    await expectHead(
      root,
      phase === "source restore" || kind === "staged-unrelated" ? beforeSha : targetSha,
    );
    await expectGit(root, "main", "rev-parse", "--abbrev-ref", "HEAD");
    await expectRuntimeRetained(root, targetSha, retained);
    await expectRetainedBackup(root, beforeSha);
  });

  it("retained rollback keeps custody during a late branch claim", async () => {
    const fixture = await advanceFixture(getFixture);
    const { root, beforeSha, runCommand, setRunCommand } = fixture;
    const linked = path.join(path.dirname(root), "linked-checkout");
    let rollingBack = false;
    let attempted = false;
    setRunCommand(async (argv, options) => {
      if (rollingBack && !attempted && isBranchCheckout(argv, root)) {
        attempted = true;
        await expect(git(root, "worktree", "add", linked, "main")).rejects.toThrow(
          /already (?:used|checked out)/,
        );
      }
      return runCommand(argv, options);
    });
    const { retained } = await activateTransaction(fixture);
    rollingBack = true;
    expect((await retained.rollback(assertCurrent)).exitCode).toBe(0);
    expect(attempted).toBe(true);
    await expectGit(root, beforeSha, "rev-parse", "refs/heads/main");
    await expectGit(root, "refs/heads/main", "symbolic-ref", "HEAD");
    await expectRuntime(root, beforeSha);
    await completeRollback(retained);
  });

  it.each(["operator-branch", "HEAD"])(
    "retained rollback keeps the created dev branch while restoring %s",
    async (branch) => {
      const fixture = getFixture();
      const { root, beforeSha, advanceRemote, expectNoRuntimeStagingPaths } = fixture;
      await git(
        root,
        "checkout",
        ...(branch === "HEAD" ? ["--detach", beforeSha] : ["-b", branch]),
      );
      await git(root, "branch", "-D", "main");
      const targetSha = await advanceRemote();
      const { retained } = await activateTransaction(fixture);
      const kept = await retained.rollback(assertCurrent);
      expect(kept.exitCode).toBe(0);
      await expectGit(root, targetSha, "rev-parse", "refs/heads/main");
      await expectHead(root, beforeSha);
      await expectGit(root, branch, "rev-parse", "--abbrev-ref", "HEAD");
      expect(kept.advisory).toMatchObject({ kind: "recoverable-maintenance" });
      expect(kept.advisory?.message).toContain(
        `Kept branch main created by this update at ${targetSha}`,
      );
      expect(kept.advisory?.message).toMatch(/git branch -d (?:main|'main')/);
      await expectRuntime(root, beforeSha);
      await completeRollback(retained);
      await expectNoRuntimeStagingPaths();
    },
  );

  it("retains the runtime backup when another worktree already holds the original branch", async () => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote } = fixture;
    await git(root, "checkout", "-b", "operator-branch");
    const targetSha = await advanceRemote();
    const { retained } = await activateTransaction(fixture);
    const holder = path.join(path.dirname(root), "holder");
    await git(root, "worktree", "add", holder, "operator-branch");
    await expect(retained.rollback(assertCurrent)).rejects.toThrow("git-rollback-checkout");
    await expectGit(root, beforeSha, "rev-parse", "operator-branch");
    await expectGit(root, "refs/heads/main", "symbolic-ref", "HEAD");
    await expectRuntimeRetained(root, targetSha, retained);
  });

  it("refuses to overwrite a late ignored file during source restoration", async () => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote, runCommand, setRunCommand } = fixture;
    const remote = await git(root, "remote", "get-url", "origin");
    await fs.rm(path.join(remote, "openclaw.mjs"));
    await git(remote, "commit", "-am", "remove launcher");
    const targetSha = await advanceRemote();
    let edited = false;
    setRunCommand(async (argv, options) => {
      if (isBranchCheckout(argv, root) && argv.at(-1) === beforeSha) {
        await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\nopenclaw.mjs\n");
        await fs.writeFile(path.join(root, "openclaw.mjs"), "operator content\n");
        edited = true;
      }
      return runCommand(argv, options);
    });
    const { retained } = await activateTransaction(fixture);
    await expect(retained.rollback(assertCurrent)).rejects.toThrow("git-rollback-source");
    expect(edited).toBe(true);
    await expectFile(path.join(root, "openclaw.mjs"), "operator content\n");
    await expectHead(root, targetSha);
    await expectRuntimeRetained(root, targetSha, retained);
  });

  it("retained rollback restores the previous generation detached when the branch reflog is missing", async () => {
    const fixture = await advanceFixture(getFixture);
    const { root, beforeSha, targetSha, expectNoRuntimeStagingPaths } = fixture;
    const { retained } = await activateTransaction(fixture);
    await git(root, "config", "core.logAllRefUpdates", "false");
    await fs.rm(path.join(root, ".git", "logs", "refs", "heads", "main"));
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\noperator-note.txt\n");
    const operatorFile = path.join(root, "operator-note.txt");
    await fs.writeFile(operatorFile, "preserve this operator note\n");

    const restored = await retained.rollback(assertCurrent);
    expect(restored.exitCode).toBe(0);
    await expectHead(root, beforeSha);
    await expect(git(root, "symbolic-ref", "-q", "HEAD")).rejects.toThrow();
    await expectGit(root, targetSha, "rev-parse", "refs/heads/main");
    await expect(git(root, "reflog", "exists", "refs/heads/main")).rejects.toThrow();
    expect(restored?.advisory).toMatchObject({ kind: "recoverable-maintenance" });
    expect(restored.advisory?.message).toContain(root);
    expect(restored.advisory?.message).toMatch(
      new RegExp(`update-ref (?:refs/heads/main|'refs/heads/main') ${beforeSha} ${targetSha}`),
    );
    await expectRuntime(root, beforeSha);
    await expectFile(operatorFile, "preserve this operator note\n");
    await expect(completeRollback(retained)).resolves.toBeUndefined();
    await expectNoRuntimeStagingPaths();
  });

  it.each(["raw-writer-before", "raw-writer-after"] as const)(
    "retained rollback keeps the runtime when the rewrite transition cannot be verified: %s",
    async (failure) => {
      const fixture = await advanceFixture(getFixture);
      const { root, beforeSha, targetSha, runCommand, setRunCommand } = fixture;
      const concurrentSha = await commitTree(root, beforeSha);
      let rollingBack = false;
      let injected = false;
      setRunCommand(async (argv, options) => {
        const rewriting = rollingBack && isBranchCheckout(argv, root);
        if (rewriting && failure === "raw-writer-before") {
          await git(root, "update-ref", "refs/heads/main", concurrentSha, targetSha);
          injected = true;
        }
        const result = await runCommand(argv, options);
        if (rewriting && failure === "raw-writer-after") {
          expect(result.code).toBe(0);
          await git(root, "update-ref", "refs/heads/main", concurrentSha, beforeSha);
          injected = true;
        }
        return result;
      });
      const { retained, result } = await activateTransaction(fixture);
      rollingBack = true;
      const rollback = retained.rollback(assertCurrent);
      await expect(rollback).rejects.toThrow("git-rollback-source");
      expect(injected).toBe(true);
      const finalSha = failure === "raw-writer-after" ? concurrentSha : beforeSha;
      await expectHead(root, finalSha);
      await expectGit(root, finalSha, "rev-parse", "refs/heads/main");
      await expectGit(root, "refs/heads/main", "symbolic-ref", "HEAD");
      const diagnostic = result.steps.find(
        (step) => step.name === "git-rollback-source",
      )?.stderrTail;
      for (const sha of [targetSha, beforeSha, concurrentSha]) {
        expect(diagnostic).toContain(sha);
      }
      if (failure === "raw-writer-before") {
        expect(diagnostic).toContain("git checkout --detach --no-overwrite-ignore");
        expect(diagnostic).toMatch(new RegExp(`git branch -f (?:main|'main') ${concurrentSha}`));
      } else {
        expect(diagnostic).not.toContain("branch -f");
        expect(diagnostic).toMatch(/git reflog (?:main|'main')/);
        expect(diagnostic).toContain("keep the newest intended commit");
      }
      await expectRuntimeRetained(root, targetSha, retained);
      await expect(completeRollback(retained)).rejects.toThrow();
      if (failure === "raw-writer-before") {
        await git(root, "checkout", "--detach", "--no-overwrite-ignore");
        await git(root, "branch", "-f", "main", concurrentSha);
        await expectGit(root, concurrentSha, "rev-parse", "refs/heads/main");
      }
    },
  );
}
