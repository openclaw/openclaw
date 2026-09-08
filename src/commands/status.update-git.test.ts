import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import * as processExec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { formatUpdateOneLiner, getUpdateCheckResult } from "./status.update.js";

const install = vi.hoisted(() => ({ root: "" }));
vi.mock(import("../infra/openclaw-root.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOpenClawPackageRoot: async () => install.root,
}));

const runCommand = processExec.runCommandWithTimeout;
async function git(root: string, ...args: string[]) {
  const result = await runCommand(["git", ...args], { cwd: root, timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

async function withGitInstall(run: (remote: string, base: string) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-status-update-" }, async (base) => {
    const remote = path.join(base, "remote.git");
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "test@openclaw.invalid");
    await git(remote, "commit", "--allow-empty", "-m", "initial");
    install.root = path.join(base, "install");
    await git(base, "clone", "--quiet", remote, install.root);
    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(base, "state") }, async () => {
      try {
        await run(remote, base);
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });
  });
}

const readStatus = (fetchGit = false) =>
  getUpdateCheckResult({ timeoutMs: 5000, fetchGit, includeRegistry: false });

afterEach(() => vi.restoreAllMocks());

describe("status update with Git and the update ledger", () => {
  it.each([
    { outcome: "no ledger", stale: false },
    { outcome: "succeeded", stale: false },
    { outcome: "fetch-failed", stale: true },
    { outcome: "fetch step", stale: true },
    { outcome: "build-failed", stale: false },
  ] as const)("reports $outcome against older refs", async ({ outcome, stale }) => {
    await withGitInstall(async () => {
      const refPath = path.resolve(
        install.root,
        await git(install.root, "rev-parse", "--git-path", "refs/remotes/origin/main"),
      );
      // Clones can pack their initial tracking refs. A loose ref gives this
      // fixture an independently controlled refresh timestamp.
      await fs.mkdir(path.dirname(refPath), { recursive: true });
      await fs.writeFile(refPath, `${await git(install.root, "rev-parse", "HEAD")}\n`);
      const old = new Date(Date.now() - 600_000);
      await fs.utimes(refPath, old, old);
      if (outcome !== "no ledger") {
        const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
        if (outcome === "fetch step") {
          recordUpdateRunStep(run.runId, {
            step: "git target inspection fetch",
            status: "failed",
            endedAtMs: Date.now(),
            detail: "Could not resolve host: example.invalid",
          });
        }
        finishUpdateRun(run.runId, {
          status: outcome === "succeeded" ? "succeeded" : "failed",
          reason: outcome === "fetch step" ? "update-failed" : outcome,
        });
      }
      const commands = vi.spyOn(processExec, "runCommandWithTimeout");
      const result = await readStatus();
      expect(result.git).toMatchObject({ ahead: 0, behind: 0, fetchOk: null });
      expect(commands.mock.calls.some(([argv]) => argv.includes("fetch"))).toBe(false);
      if (stale) {
        expect(result.git).toMatchObject({
          countsCached: true,
          stale: { reason: "fetch-failed", failedAtMs: expect.any(Number) },
        });
        expect(formatUpdateOneLiner(result)).toContain("update check stale: last fetch failed");
        expect(formatUpdateOneLiner(result)).not.toContain("up to date");
      } else {
        expect(result.git).not.toHaveProperty("stale");
        expect(formatUpdateOneLiner(result)).toContain("up to date");
      }
    });
  });

  it.each([
    { worktree: false, sibling: false, url: "path" },
    { worktree: true, sibling: false, url: "path" },
    { worktree: true, sibling: true, url: "path" },
    { worktree: true, sibling: true, url: "file" },
    { worktree: false, sibling: false, url: "relative" },
  ])(
    "clears a recorded failure after a fresh fetch (worktree=$worktree, sibling=$sibling, url=$url)",
    async ({ worktree, sibling, url }) => {
      await withGitInstall(async (remote, base) => {
        const primaryRoot = install.root;
        if (worktree) {
          const linked = path.join(base, "linked");
          await git(install.root, "worktree", "add", "-b", "linked", linked);
          await git(linked, "branch", "--set-upstream-to=origin/main");
          install.root = linked;
        }
        const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
        await git(install.root, "remote", "set-url", "origin", path.join(base, "missing"));
        const failed = await runCommand(["git", "fetch", "origin"], {
          cwd: install.root,
          timeoutMs: 5000,
        });
        expect(failed.code).not.toBe(0);
        recordUpdateRunStep(run.runId, {
          step: "git fetch",
          status: "failed",
          endedAtMs: Date.now(),
          detail: "network unavailable",
        });
        const finished = finishUpdateRun(run.runId, { status: "failed", reason: "fetch-failed" });
        const fetchPath = path.resolve(
          install.root,
          await git(install.root, "rev-parse", "--git-path", "FETCH_HEAD"),
        );
        expect(await fs.readFile(fetchPath, "utf8")).toBe("");
        expect((await readStatus()).git?.stale).toMatchObject({ runId: run.runId });

        // Packing unrelated refs and an empty failed FETCH_HEAD are not recovery.
        await git(install.root, "pack-refs", "--all");
        const later = new Date(finished.finishedAtMs! + 2000);
        await fs.utimes(fetchPath, later, later);
        expect((await readStatus()).git?.stale).toBeDefined();

        let recoveryUrl = remote;
        if (url === "file") {
          const fileUrl = pathToFileURL(remote);
          fileUrl.hostname = "localhost";
          // Git accepts userinfo in a file transport URL and removes it from FETCH_HEAD.
          recoveryUrl = fileUrl.href.replace("file://", "file://fixture:synthetic@") + "///";
        } else if (url === "relative") {
          recoveryUrl = path.relative(install.root, remote) + "//";
        }
        await git(install.root, "remote", "set-url", "origin", recoveryUrl);
        const statusRoot = install.root;
        if (sibling) {
          install.root = primaryRoot;
        }
        const fresh = await readStatus(true);
        expect(fresh.git).toMatchObject({ fetchOk: true, ahead: 0, behind: 0 });
        expect(fresh.git).not.toHaveProperty("stale");
        // A no-change fetch refreshes FETCH_HEAD even when the packed ref stays put.
        const recoveryFetchPath = path.resolve(
          install.root,
          await git(install.root, "rev-parse", "--git-path", "FETCH_HEAD"),
        );
        await fs.utimes(recoveryFetchPath, later, later);
        install.root = statusRoot;
        expect((await readStatus()).git).not.toHaveProperty("stale");
      });
    },
  );

  it("keeps partial refs from a rejected tag fetch labeled as cached", async () => {
    await withGitInstall(async (remote) => {
      await git(install.root, "tag", "v2000.1.1");
      await git(remote, "commit", "--allow-empty", "-m", "newer");
      await git(remote, "tag", "v2000.1.1");
      const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      // Git versions differ in whether a rejected tag fetch advances branch refs.
      await git(install.root, "fetch", "--no-tags", "origin");
      const failed = await runCommand(["git", "fetch", "--tags", "origin"], {
        cwd: install.root,
        timeoutMs: 5000,
      });
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain("would clobber existing tag");
      recordUpdateRunStep(run.runId, {
        step: "git fetch",
        status: "failed",
        endedAtMs: Date.now(),
        detail: failed.stderr,
      });
      finishUpdateRun(run.runId, { status: "failed", reason: "fetch-failed" });
      const result = await readStatus();
      expect(result.git).toMatchObject({
        ahead: 0,
        behind: 1,
        countsCached: true,
        stale: { detail: "tag conflict", runId: run.runId },
      });
    });
  });

  it("does not clear a failed upstream fetch after fetching another remote at the cached commit", async () => {
    await withGitInstall(async (remote, base) => {
      const backup = path.join(base, "backup.git");
      await git(base, "clone", "--bare", "--quiet", remote, backup);
      await git(install.root, "remote", "add", "backup", backup);
      const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      const finished = finishUpdateRun(run.runId, { status: "failed", reason: "fetch-failed" });
      await git(install.root, "fetch", "backup", "main");
      const fetchPath = path.resolve(
        install.root,
        await git(install.root, "rev-parse", "--git-path", "FETCH_HEAD"),
      );
      const later = new Date(finished.finishedAtMs! + 2000);
      await fs.utimes(fetchPath, later, later);
      expect((await readStatus()).git?.stale).toMatchObject({ runId: run.runId });
    });
  });

  it("ignores shared ref writes from a sibling with a different relative remote", async () => {
    await withGitInstall(async (remote, base) => {
      const nested = path.join(base, "nested");
      await fs.mkdir(nested);
      const otherRemote = path.join(nested, "remote.git");
      await git(base, "clone", "--quiet", remote, otherRemote);
      await git(otherRemote, "config", "user.name", "OpenClaw Test");
      await git(otherRemote, "config", "user.email", "test@openclaw.invalid");
      await git(otherRemote, "commit", "--allow-empty", "-m", "different remote");
      const sibling = path.join(nested, "sibling");
      await git(install.root, "worktree", "add", "-b", "sibling", sibling);
      await git(install.root, "remote", "set-url", "origin", "../remote.git");
      const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      const finished = finishUpdateRun(run.runId, { status: "failed", reason: "fetch-failed" });
      await git(sibling, "fetch", "origin");
      const refPath = path.resolve(
        install.root,
        await git(install.root, "rev-parse", "--git-path", "refs/remotes/origin/main"),
      );
      const later = new Date(finished.finishedAtMs! + 2000);
      await fs.utimes(refPath, later, later);
      expect((await readStatus()).git?.stale).toMatchObject({ runId: run.runId });
    });
  });
});
