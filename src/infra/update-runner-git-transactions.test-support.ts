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
  runFixtureGit,
  expectHead,
  expectMissing,
  expectFile,
  readText,
  type GitCandidateFixture,
} from "./update-runner-git-candidate.test-support.js";

type TransactionFixture = ReturnType<Parameters<typeof registerGitActivationDoctorOutcomeTests>[0]>;
const assertCurrent = () => {};

async function activateTransaction({ update }: TransactionFixture) {
  let retained: PackageUpdateTransaction | undefined;
  const result = await update({
    onTransaction: (transaction) => {
      retained = transaction;
    },
  });
  expect(result.status).toBe("ok");
  assert(retained);
  return { retained, result };
}

async function expectGeneration(root: string, sha: string) {
  await expectHead(root, sha);
  await expectRuntime(root, sha);
}

async function expectGit(root: string, expected: string, ...args: string[]) {
  expect(await runFixtureGit(root, ...args)).toBe(expected);
}

function commitTree(root: string, parent: string) {
  return runFixtureGit(
    root,
    "commit-tree",
    `${parent}^{tree}`,
    "-p",
    parent,
    "-m",
    "operator commit",
  );
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
  it.each(["refuse", "cleanup-failed"] as const)(
    "keeps the Git validation runtime usable through late admission and finalization: %s",
    async (outcome) => {
      const fixture = getFixture();
      const { root, beforeSha, advanceRemote, update, expectNoRuntimeStagingPaths } = fixture;
      const target = await advanceRemote();
      let candidateRoot: string | undefined;
      let retained: PackageUpdateTransaction | undefined;
      const boundaries: string[] = [];
      let denyCleanup = false;
      const validateRetained = async () => {
        assert(candidateRoot);
        await expectGeneration(candidateRoot, target);
      };
      fixture.setRunCommand(async (argv, options) => {
        if (denyCleanup && argv.includes("worktree") && argv.includes("remove")) {
          return { code: 1, stdout: "", stderr: "candidate cleanup denied" };
        }
        const boundary = argv.includes("index-pack")
          ? "transfer"
          : argv.includes("checkout")
            ? "checkout"
            : undefined;
        if (
          argv[0] === "git" &&
          argv[2] === root &&
          boundary &&
          !argv.some((arg) => arg.startsWith("--git-dir="))
        ) {
          await validateRetained();
          await expectHead(root, beforeSha);
          boundaries.push(boundary);
        }
        return fixture.runCommand(argv, options);
      });
      const pending = update({
        validateCandidate: async (directory) => {
          candidateRoot = directory;
          expect(fixture.isStopped()).toBe(false);
          await validateRetained();
        },
        onTransaction: (transaction) => {
          retained = transaction;
        },
        ...(outcome === "refuse"
          ? {
              beforeGitMutation: async () => {
                await validateRetained();
                expect(fixture.isStopped()).toBe(false);
                throw new Error("synthetic late admission refusal");
              },
            }
          : {}),
      });
      if (outcome === "refuse") {
        await expect(pending).rejects.toThrow("synthetic late admission refusal");
        expect(fixture.isStopped()).toBe(false);
        expect(retained).toBeUndefined();
        await expectHead(root, beforeSha);
      } else {
        const result = await pending;
        expect(result.status, JSON.stringify(result)).toBe("ok");
        expect(boundaries).toEqual(["transfer", "checkout"]);
        assert(retained);
        await validateRetained();
        denyCleanup = true;
        assert(candidateRoot);
        await expectCleanupWarning(retained, [path.dirname(candidateRoot), candidateRoot]);
        await validateRetained();
        await expectRuntimeRetained(root, target, retained);
        return;
      }
      assert(candidateRoot);
      await expectMissing(candidateRoot);
      await expectNoRuntimeStagingPaths();
    },
  );

  it.each(["cleanup-failed", "source-changed", "doctor-entry-missing"] as const)(
    "retains the activated Git transaction through finalization: %s",
    async (outcome) => {
      const { root, beforeSha, advanceRemote, update, expectNoRuntimeStagingPaths } = getFixture();
      const targetSha = await advanceRemote();
      let retained: PackageUpdateTransaction | undefined;
      const missingDoctor = outcome === "doctor-entry-missing";
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
        ...(missingDoctor ? { runGitDoctor: async () => null } : {}),
      });
      expect(result.status).toBe(missingDoctor ? "error" : "ok");
      assert(retained, "Finalization must receive the retained Git runtime transaction");
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      if (missingDoctor) {
        expect(result.reason).toBe("doctor-entry-missing");
        await expectGeneration(root, targetSha);
      } else {
        expect(result.gitRuntime).toEqual({
          commit: targetSha,
          distDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
      }
      if (outcome === "cleanup-failed") {
        const backupRoot = retained.backupRoot;
        const warning = await expectCleanupWarning(retained, [backupRoot]);
        expect(warning?.advisory?.message).toContain(backupRoot);
        await expectRuntimeRetained(root, targetSha, retained);
        return;
      }
      if (outcome === "source-changed") {
        await fs.writeFile(path.join(root, "operator-edit.txt"), "preserve this edit\n");
        await expect(retained.rollback(assertCurrent)).rejects.toThrow("changed after activation");
        await expect(
          retained.complete({ activationVerified: false }, assertCurrent),
        ).rejects.toThrow("changed after activation");
        await expectHead(root, targetSha);
        await expectFile(path.join(root, "operator-edit.txt"), "preserve this edit\n");
        await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
        return;
      }
      const restored = await retained.rollback(assertCurrent);
      expect(restored.exitCode).toBe(0);
      await retained.complete({ activationVerified: false }, assertCurrent);
      await expectGeneration(root, beforeSha);
      await expectNoRuntimeStagingPaths();
    },
  );
  it.each([
    ["config-refused", "repair-requires-config-change"],
    ["requester-revoked", "requester-revoked"],
    ["doctor-zero-exit-timeout", "doctor-failed"],
    ["cleanup-uncertain", undefined],
  ] as const)(
    "uses the CLI activation Doctor and preserves its outcome: %s",
    async (outcome, reason) => {
      const fixture = getFixture();
      const { root, beforeSha, events, isStopped, advanceRemote, update } = fixture;
      const targetSha = await advanceRemote();
      const configChanges: UpdateDoctorConfigChange[] = [{ kind: "key", key: "agents" }];
      const cleanupError = new Error("Doctor child cleanup remains unresolved", {
        cause: new CommandProcessCleanupError(),
      });
      const runGitDoctor = vi.fn(async (doctorRoot: string) => {
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
      });

      const running = update({ runGitDoctor });
      const result = outcome === "cleanup-uncertain" ? undefined : await running;
      if (!result) {
        await expect(running).rejects.toBe(cleanupError);
      }
      expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
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

function registerGitRetainedTransactionTests(
  getFixture: Parameters<typeof registerGitActivationDoctorOutcomeTests>[0],
) {
  it.each([
    ["source check", "tracked"],
    ["checkout", "tracked"],
    ["source restore", "untracked"],
    ["before checkout", "tracked"],
    ["before source restore", "tracked"],
    ["before source restore", "staged"],
    ["before source restore", "staged-unrelated"],
  ] as const)("retained rollback preserves %s await edits (%s)", async (phase, kind) => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote, runCommand, setRunCommand } = fixture;
    const targetSha = await advanceRemote();
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
          await runFixtureGit(root, "add", relative);
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
      expect(await runFixtureGit(root, "show", `:${relative}`)).toBe(edit.trim());
    }
    if (kind === "staged-unrelated") {
      expect(await runFixtureGit(root, "status", "--short")).toContain("MM openclaw.mjs");
    }
    await expect(retained.complete({ activationVerified: false }, assertCurrent)).rejects.toThrow();
    await expectHead(
      root,
      phase === "source restore" || kind === "staged-unrelated" ? beforeSha : targetSha,
    );
    await expectGit(root, "main", "rev-parse", "--abbrev-ref", "HEAD");
    await expectRuntimeRetained(root, targetSha, retained);
    await expectRetainedBackup(root, beforeSha);
  });

  it("retained rollback keeps custody during a late branch claim", async () => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote, runCommand, setRunCommand } = fixture;
    const linked = path.join(path.dirname(root), "linked-checkout");
    await advanceRemote();
    let rollingBack = false;
    let attempted = false;
    setRunCommand(async (argv, options) => {
      if (rollingBack && !attempted && isBranchCheckout(argv, root)) {
        attempted = true;
        await expect(runFixtureGit(root, "worktree", "add", linked, "main")).rejects.toThrow(
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
    await retained.complete({ activationVerified: false }, assertCurrent);
  });

  it.each(["operator-branch", "HEAD"])(
    "retained rollback keeps the created dev branch while restoring %s",
    async (branch) => {
      const fixture = getFixture();
      const { root, beforeSha, advanceRemote, expectNoRuntimeStagingPaths } = fixture;
      await runFixtureGit(
        root,
        "checkout",
        ...(branch === "HEAD" ? ["--detach", beforeSha] : ["-b", branch]),
      );
      await runFixtureGit(root, "branch", "-D", "main");
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
      await retained.complete({ activationVerified: false }, assertCurrent);
      await expectNoRuntimeStagingPaths();
    },
  );

  it("retains the runtime backup when another worktree already holds the original branch", async () => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote } = fixture;
    await runFixtureGit(root, "checkout", "-b", "operator-branch");
    const targetSha = await advanceRemote();
    const { retained } = await activateTransaction(fixture);
    const holder = path.join(path.dirname(root), "holder");
    await runFixtureGit(root, "worktree", "add", holder, "operator-branch");
    await expect(retained.rollback(assertCurrent)).rejects.toThrow("git-rollback-checkout");
    await expectGit(root, beforeSha, "rev-parse", "operator-branch");
    await expectGit(root, "refs/heads/main", "symbolic-ref", "HEAD");
    await expectRuntimeRetained(root, targetSha, retained);
  });

  it("refuses to overwrite a late ignored file during source restoration", async () => {
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote, runCommand, setRunCommand } = fixture;
    const remote = await runFixtureGit(root, "remote", "get-url", "origin");
    await fs.rm(path.join(remote, "openclaw.mjs"));
    await runFixtureGit(remote, "commit", "-am", "remove launcher");
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
    const fixture = getFixture();
    const { root, beforeSha, advanceRemote, expectNoRuntimeStagingPaths } = fixture;
    const targetSha = await advanceRemote();
    const { retained } = await activateTransaction(fixture);
    await runFixtureGit(root, "config", "core.logAllRefUpdates", "false");
    await fs.rm(path.join(root, ".git", "logs", "refs", "heads", "main"));
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\noperator-note.txt\n");
    const operatorFile = path.join(root, "operator-note.txt");
    await fs.writeFile(operatorFile, "preserve this operator note\n");

    const restored = await retained.rollback(assertCurrent);
    expect(restored.exitCode).toBe(0);
    await expectHead(root, beforeSha);
    await expect(runFixtureGit(root, "symbolic-ref", "-q", "HEAD")).rejects.toThrow();
    await expectGit(root, targetSha, "rev-parse", "refs/heads/main");
    await expect(runFixtureGit(root, "reflog", "exists", "refs/heads/main")).rejects.toThrow();
    expect(restored?.advisory).toMatchObject({ kind: "recoverable-maintenance" });
    expect(restored.advisory?.message).toContain(root);
    expect(restored.advisory?.message).toMatch(
      new RegExp(`update-ref (?:refs/heads/main|'refs/heads/main') ${beforeSha} ${targetSha}`),
    );
    // The suggested restore is compare-and-swap: a later branch writer keeps its commit.
    const advanced = await commitTree(root, targetSha);
    await runFixtureGit(root, "update-ref", "refs/heads/main", advanced, targetSha);
    await expect(
      runFixtureGit(root, "update-ref", "refs/heads/main", beforeSha, targetSha),
    ).rejects.toThrow();
    await expectGit(root, advanced, "rev-parse", "refs/heads/main");
    await expectRuntime(root, beforeSha);
    await expectFile(operatorFile, "preserve this operator note\n");
    await expect(
      retained.complete({ activationVerified: false }, assertCurrent),
    ).resolves.toBeUndefined();
    await expectNoRuntimeStagingPaths();
  });

  it.each(["raw-writer-before", "raw-writer-after"] as const)(
    "retained rollback keeps the runtime when the rewrite transition cannot be verified: %s",
    async (failure) => {
      const fixture = getFixture();
      const { root, beforeSha, advanceRemote, runCommand, setRunCommand } = fixture;
      const targetSha = await advanceRemote();
      const concurrentSha = await commitTree(root, beforeSha);
      let rollingBack = false;
      let injected = false;
      setRunCommand(async (argv, options) => {
        const rewriting = rollingBack && isBranchCheckout(argv, root);
        if (rewriting && failure === "raw-writer-before") {
          await runFixtureGit(root, "update-ref", "refs/heads/main", concurrentSha, targetSha);
          injected = true;
        }
        const result = await runCommand(argv, options);
        if (rewriting && failure === "raw-writer-after") {
          expect(result.code).toBe(0);
          await runFixtureGit(root, "update-ref", "refs/heads/main", concurrentSha, beforeSha);
          injected = true;
        }
        return result;
      });
      const { retained, result } = await activateTransaction(fixture);
      rollingBack = true;
      const rollback = retained.rollback(assertCurrent);
      await expect(rollback).rejects.toThrow("git-rollback-source");
      for (const sha of [targetSha, beforeSha, concurrentSha]) {
        await expect(rollback).rejects.toThrow(sha);
      }
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
      await expect(
        retained.complete({ activationVerified: false }, assertCurrent),
      ).rejects.toThrow();
      if (failure === "raw-writer-before") {
        await runFixtureGit(root, "checkout", "--detach", "--no-overwrite-ignore");
        await runFixtureGit(root, "branch", "-f", "main", concurrentSha);
        await expectGit(root, concurrentSha, "rev-parse", "refs/heads/main");
      }
    },
  );
}
