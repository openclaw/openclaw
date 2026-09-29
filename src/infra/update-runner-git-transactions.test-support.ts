import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { expectRuntime, runFixtureGit } from "./update-runner-git-candidate.test-support.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

export function registerGitActivationDoctorOutcomeTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    events: string[];
    isStopped: () => boolean;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    advanceRemote: () => Promise<string>;
    git: (root: string, ...args: string[]) => Promise<string>;
    update: (
      opts: Pick<UpdateRunnerOptions, "runGitDoctor" | "onTransaction">,
    ) => Promise<UpdateRunResult>;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  registerGitRetainedTransactionTests(getFixture);
  it.each([
    "restore",
    "complete",
    "cleanup-failed",
    "source-changed",
    "runtime-changed",
    "doctor-entry-missing",
  ] as const)("retains the activated Git transaction through finalization: %s", async (outcome) => {
    const { root, beforeSha, advanceRemote, git, update, expectNoRuntimeStagingPaths } =
      getFixture();
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
      expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
      await expectRuntime(root, targetSha);
    } else {
      expect(result.gitRuntime).toEqual({
        commit: targetSha,
        distDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
    if (outcome === "cleanup-failed") {
      const remove = fs.rm.bind(fs);
      const backupRoot = retained.backupRoot;
      const removal = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
        if (entry === backupRoot) {
          throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
        }
        return remove(entry, options);
      });
      try {
        const warning = await retained.complete({ activationVerified: true }, () => {});
        expect(warning).toMatchObject({
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining(backupRoot),
          },
        });
        expect(await retained.complete({ activationVerified: true }, () => {})).toBe(warning);
        await expectRuntime(root, targetSha);
        await expect(fs.stat(backupRoot)).resolves.toBeDefined();
      } finally {
        removal.mockRestore();
      }
      return;
    }
    if (outcome === "complete") {
      await retained.complete({ activationVerified: true }, () => {});
      await expectRuntime(root, targetSha);
      await expectNoRuntimeStagingPaths();
      return;
    }
    if (outcome === "source-changed") {
      await fs.writeFile(path.join(root, "operator-edit.txt"), "preserve this edit\n");
      await expect(retained.rollback(() => {})).rejects.toThrow("changed after activation");
      await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow(
        "changed after activation",
      );
      expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
      expect(await fs.readFile(path.join(root, "operator-edit.txt"), "utf8")).toBe(
        "preserve this edit\n",
      );
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      return;
    } else if (outcome === "runtime-changed") {
      await fs.writeFile(path.join(root, "dist", "operator-chunk.mjs"), "export {};\n");
    }
    const restored = await retained.rollback(() => {});
    expect(restored.exitCode).toBe(0);
    await retained.complete({ activationVerified: false }, () => {});
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expectRuntime(root, beforeSha);
    await expectNoRuntimeStagingPaths();
  });
  it.each([
    ["success", undefined],
    ["config-refused", "repair-requires-config-change"],
    ["requester-revoked", "requester-revoked"],
    ["doctor-error", "doctor-failed"],
    ["doctor-zero-exit-timeout", "doctor-failed"],
    ["doctor-zero-exit-output-limit", "doctor-failed"],
    ["doctor-throw", "unexpected-error"],
    ["cleanup-uncertain", undefined],
    ["missing", "doctor-entry-missing"],
  ] as const)(
    "uses the CLI activation Doctor and preserves its outcome: %s",
    async (outcome, reason) => {
      const {
        root,
        beforeSha,
        events,
        isStopped,
        advanceRemote,
        git,
        update,
        expectNoRuntimeStagingPaths,
      } = getFixture();
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
        if (outcome === "doctor-throw") {
          throw new Error("Doctor failed after starting migration");
        }
        if (outcome === "cleanup-uncertain") {
          throw cleanupError;
        }
        if (outcome === "missing") {
          return null;
        }
        return {
          name: "openclaw doctor",
          command: "candidate doctor",
          cwd: doctorRoot,
          durationMs: 1,
          exitCode: outcome === "success" || outcome.startsWith("doctor-zero-exit-") ? 0 : 1,
          ...(outcome === "doctor-zero-exit-timeout" ? { termination: "timeout" as const } : {}),
          ...(outcome === "doctor-zero-exit-output-limit" ? { outputLimitExceeded: true } : {}),
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
      if (outcome === "cleanup-uncertain") {
        await expect(running).rejects.toBe(cleanupError);
        expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
        expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
        expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
        await expectRuntime(root, targetSha);
        const backups = (await fs.readdir(root)).filter(
          (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
        );
        expect(backups).toHaveLength(1);
        const backup = backups[0];
        assert(backup);
        expect(
          JSON.parse(
            await fs.readFile(path.join(root, backup, "previous", "build-info.json"), "utf8"),
          ),
        ).toMatchObject({ commit: beforeSha, buildId: beforeSha });
        return;
      }
      const result = await running;

      expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
      expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
      expect(result.status).toBe(outcome === "success" ? "ok" : "error");
      expect(result.reason).toBe(reason);
      const expectedSha = outcome === "missing" ? beforeSha : targetSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      await expectRuntime(root, expectedSha);
      await expectNoRuntimeStagingPaths();
      if (outcome !== "success") {
        expect(result.recovery).toMatchObject(
          outcome === "missing"
            ? { serviceRestartSafe: true, buildId: beforeSha }
            : { serviceRestartSafe: false, reason: "state-migration-started" },
        );
      }
      if (outcome !== "requester-revoked" && outcome !== "doctor-throw" && outcome !== "missing") {
        expect(result.steps.find((step) => step.name === "openclaw doctor")?.configChanges).toEqual(
          configChanges,
        );
      }
    },
  );
}

function registerGitRetainedTransactionTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    advanceRemote: () => Promise<string>;
    update: (opts: Partial<UpdateRunnerOptions>) => Promise<UpdateRunResult>;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  it.each([
    ["source check", "tracked"],
    ["source check", "untracked"],
    ["checkout", "tracked"],
    ["checkout", "untracked"],
    ["source restore", "tracked"],
    ["source restore", "untracked"],
    ["before checkout", "tracked"],
    ["before source restore", "tracked"],
    ["before source restore", "staged"],
    ["before source restore", "staged-unrelated"],
  ] as const)("retained rollback preserves %s await edits (%s)", async (phase, kind) => {
    const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
    const targetSha = await advanceRemote();
    const relative =
      kind === "untracked"
        ? "operator-edit.txt"
        : phase === "source restore" || kind === "staged-unrelated"
          ? "openclaw.mjs"
          : "candidate.txt";
    const file = path.join(root, relative);
    const edit = "preserve this operator edit\n";
    let rollingBack = false;
    let edited = false;
    let retained: PackageUpdateTransaction | undefined;
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
    expect(
      (
        await update({
          onTransaction: (transaction) => {
            retained = transaction;
          },
        })
      ).status,
    ).toBe("ok");
    assert(retained);
    rollingBack = true;
    const failure = await retained
      .rollback(() => {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(edited).toBe(true);
    expect(await fs.readFile(file, "utf8").catch(() => undefined)).toBe(
      kind === "staged-unrelated" ? `${edit}unstaged content\n` : edit,
    );
    if (kind === "staged" || kind === "staged-unrelated") {
      expect(await runFixtureGit(root, "show", `:${relative}`)).toBe(edit.trim());
    }
    if (kind === "staged-unrelated") {
      expect(await runFixtureGit(root, "status", "--short")).toContain("MM openclaw.mjs");
    }
    expect(failure).toBeInstanceOf(Error);
    await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
    expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(
      phase === "source restore" || kind === "staged-unrelated" ? beforeSha : targetSha,
    );
    expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await expectRuntime(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    const distBackup = (await fs.readdir(root)).find(
      (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
    );
    assert(distBackup);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, distBackup, "previous", "build-info.json"), "utf8"),
      ),
    ).toMatchObject({ commit: beforeSha });
  });

  it.each([false, true])(
    "retained rollback keeps custody during branch rewrite (late claim: %s)",
    async (claim) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const linked = path.join(path.dirname(root), "linked-checkout");
      await advanceRemote();
      let rollingBack = false;
      let attempted = false;
      setRunCommand(async (argv, options) => {
        if (
          rollingBack &&
          !attempted &&
          argv[2] === root &&
          argv.includes("checkout") &&
          argv.includes("-B")
        ) {
          attempted = true;
          if (claim) {
            await expect(runFixtureGit(root, "worktree", "add", linked, "main")).rejects.toThrow(
              /already (?:used|checked out)/,
            );
          }
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      expect(
        (
          await update({
            onTransaction: (transaction) => {
              retained = transaction;
            },
          })
        ).status,
      ).toBe("ok");
      assert(retained);
      rollingBack = true;
      expect((await retained.rollback(() => {})).exitCode).toBe(0);
      expect(attempted).toBe(true);
      expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(beforeSha);
      expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      await expectRuntime(root, beforeSha);
      await retained.complete({ activationVerified: false }, () => {});
    },
  );

  it.each(["operator-branch", "HEAD"])(
    "retained rollback keeps the created dev branch while restoring %s",
    async (branch) => {
      const { root, beforeSha, advanceRemote, update, expectNoRuntimeStagingPaths } = getFixture();
      await runFixtureGit(
        root,
        "checkout",
        ...(branch === "HEAD" ? ["--detach", beforeSha] : ["-b", branch]),
      );
      await runFixtureGit(root, "branch", "-D", "main");
      const targetSha = await advanceRemote();
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained);
      const kept = await retained.rollback(() => {});
      expect(kept.exitCode).toBe(0);
      expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(targetSha);
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(kept?.advisory).toMatchObject({ kind: "recoverable-maintenance" });
      expect(kept?.advisory?.message).toContain(
        `Kept branch main created by this update at ${targetSha}`,
      );
      expect(kept?.advisory?.message).toMatch(/git branch -d (?:main|'main')/);
      await expectRuntime(root, beforeSha);
      await retained.complete({ activationVerified: false }, () => {});
      await expectNoRuntimeStagingPaths();
    },
  );

  it("retains the runtime backup when another worktree already holds the original branch", async () => {
    const { root, beforeSha, advanceRemote, update } = getFixture();
    await runFixtureGit(root, "checkout", "-b", "operator-branch");
    const targetSha = await advanceRemote();
    let retained: PackageUpdateTransaction | undefined;
    expect(
      (
        await update({
          onTransaction: (transaction) => {
            retained = transaction;
          },
        })
      ).status,
    ).toBe("ok");
    assert(retained);
    await runFixtureGit(
      root,
      "worktree",
      "add",
      path.join(path.dirname(root), "holder"),
      "operator-branch",
    );
    await expect(retained.rollback(() => {})).rejects.toThrow("git-rollback-checkout");
    expect(await runFixtureGit(root, "rev-parse", "operator-branch")).toBe(beforeSha);
    expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    await expectRuntime(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
  });

  it.each(["untracked", "ignored"] as const)(
    "refuses to overwrite a late %s file during source restoration",
    async (kind) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const remote = await runFixtureGit(root, "remote", "get-url", "origin");
      await fs.rm(path.join(remote, "openclaw.mjs"));
      await runFixtureGit(remote, "commit", "-am", "remove launcher");
      const targetSha = await advanceRemote();
      let edited = false;
      setRunCommand(async (argv, options) => {
        if (
          argv[2] === root &&
          argv.includes("checkout") &&
          argv.includes("-B") &&
          argv.at(-1) === beforeSha
        ) {
          if (kind === "ignored") {
            await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\nopenclaw.mjs\n");
          }
          await fs.writeFile(path.join(root, "openclaw.mjs"), "operator content\n");
          edited = true;
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      expect(
        (
          await update({
            onTransaction: (transaction) => {
              retained = transaction;
            },
          })
        ).status,
      ).toBe("ok");
      assert(retained);
      await expect(retained.rollback(() => {})).rejects.toThrow("git-rollback-source");
      expect(edited).toBe(true);
      expect(await fs.readFile(path.join(root, "openclaw.mjs"), "utf8")).toBe("operator content\n");
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(targetSha);
      await expectRuntime(root, targetSha);
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    },
  );

  it("retained rollback restores the previous generation detached when the branch reflog is missing", async () => {
    const { root, beforeSha, advanceRemote, update, expectNoRuntimeStagingPaths } = getFixture();
    const targetSha = await advanceRemote();
    let retained: PackageUpdateTransaction | undefined;
    const result = await update({
      onTransaction: (transaction) => {
        retained = transaction;
      },
    });
    expect(result.status).toBe("ok");
    assert(retained);
    await runFixtureGit(root, "config", "core.logAllRefUpdates", "false");
    await fs.rm(path.join(root, ".git", "logs", "refs", "heads", "main"));
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\noperator-note.txt\n");
    const operatorFile = path.join(root, "operator-note.txt");
    await fs.writeFile(operatorFile, "preserve this operator note\n");

    const restored = await retained.rollback(() => {});
    expect(restored.exitCode).toBe(0);
    expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expect(runFixtureGit(root, "symbolic-ref", "-q", "HEAD")).rejects.toThrow();
    expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(targetSha);
    await expect(runFixtureGit(root, "reflog", "exists", "refs/heads/main")).rejects.toThrow();
    expect(restored?.advisory).toMatchObject({ kind: "recoverable-maintenance" });
    expect(restored.advisory?.message).toContain(root);
    expect(restored.advisory?.message).toMatch(
      new RegExp(`update-ref (?:refs/heads/main|'refs/heads/main') ${beforeSha} ${targetSha}`),
    );
    // The suggested restore is compare-and-swap: a later branch writer keeps its commit.
    const advanced = await runFixtureGit(
      root,
      "commit-tree",
      `${targetSha}^{tree}`,
      "-p",
      targetSha,
      "-m",
      "operator commit",
    );
    await runFixtureGit(root, "update-ref", "refs/heads/main", advanced, targetSha);
    await expect(
      runFixtureGit(root, "update-ref", "refs/heads/main", beforeSha, targetSha),
    ).rejects.toThrow();
    expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(advanced);
    await expectRuntime(root, beforeSha);
    expect(await fs.readFile(operatorFile, "utf8")).toBe("preserve this operator note\n");
    await expect(
      retained.complete({ activationVerified: false }, () => {}),
    ).resolves.toBeUndefined();
    await expectNoRuntimeStagingPaths();
  });

  it.each(["raw-writer-before", "raw-writer-after"] as const)(
    "retained rollback keeps the runtime when the rewrite transition cannot be verified: %s",
    async (failure) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const targetSha = await advanceRemote();
      const concurrentSha = await runFixtureGit(
        root,
        "commit-tree",
        `${beforeSha}^{tree}`,
        "-p",
        beforeSha,
        "-m",
        "operator ref",
      );
      let rollingBack = false;
      let injected = false;
      setRunCommand(async (argv, options) => {
        const rewriting =
          rollingBack && argv[2] === root && argv.includes("checkout") && argv.includes("-B");
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
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained);
      rollingBack = true;
      const rollback = retained.rollback(() => {});
      await expect(rollback).rejects.toThrow("git-rollback-source");
      for (const sha of [targetSha, beforeSha, concurrentSha]) {
        await expect(rollback).rejects.toThrow(sha);
      }
      expect(injected).toBe(true);
      const finalSha = failure === "raw-writer-after" ? concurrentSha : beforeSha;
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(finalSha);
      expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(finalSha);
      expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      const diagnostic = result.steps.find(
        (step) => step.name === "git-rollback-source",
      )?.stderrTail;
      expect(diagnostic).toContain(targetSha);
      expect(diagnostic).toContain(beforeSha);
      expect(diagnostic).toContain(concurrentSha);
      if (failure === "raw-writer-before") {
        expect(diagnostic).toContain("git checkout --detach --no-overwrite-ignore");
        expect(diagnostic).toMatch(new RegExp(`git branch -f (?:main|'main') ${concurrentSha}`));
      } else {
        expect(diagnostic).not.toContain("branch -f");
        expect(diagnostic).toMatch(/git reflog (?:main|'main')/);
        expect(diagnostic).toContain("keep the newest intended commit");
      }
      await expectRuntime(root, targetSha);
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
      if (failure === "raw-writer-before") {
        await runFixtureGit(root, "checkout", "--detach", "--no-overwrite-ignore");
        await runFixtureGit(root, "branch", "-f", "main", concurrentSha);
        expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(concurrentSha);
      }
    },
  );
}
