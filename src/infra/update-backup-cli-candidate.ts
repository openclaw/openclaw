import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { collectGitRuntimeErrors, readGitRuntimeArtifactIdentity } from "./update-git-runtime.js";
import {
  assertImmutableGitConfig,
  resolveImmutableGenerationEnv,
} from "./update-immutable-generation.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "./update-run-timeouts.js";
import { runStep } from "./update-runner-command.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import { fetchGitUpdateTarget, withGitTargetInspectionRoot } from "./update-runner-git-target.js";
import type { CommandRunner } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const RECEIPT = "openclaw-backup-cli.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{40}$/u;
const TIMEOUT_MS = DEFAULT_UPDATE_STEP_TIMEOUT_MS;

export type PreparedBackupCli = {
  kind: "prepared-backup-cli";
  version: 1;
  id: string;
  operationId: string;
  sha: string;
  root: string;
  rootIdentity: { dev: string; ino: string };
  buildDigest: string;
  preparedAtMs: number;
};

async function candidateParent(controlRoot: string): Promise<string> {
  // The native updater permits .artifacts to redirect to another volume.
  const artifacts = await fs.realpath(path.join(controlRoot, ".artifacts"));
  if (!(await fs.stat(artifacts)).isDirectory()) {
    throw new Error("Backup CLI artifact storage is not a directory.");
  }
  return path.join(artifacts, "backup-cli-candidates");
}

async function controlRoot(root: string): Promise<string> {
  const physical = await fs.realpath(root);
  if (physical !== path.resolve(root) || !(await fs.lstat(path.join(root, ".git"))).isDirectory()) {
    throw new Error("Backup CLI preparation requires a physical Git source checkout.");
  }
  return physical;
}

async function privateParent(root: string): Promise<string> {
  await fs.mkdir(path.join(root, ".artifacts"), { recursive: true });
  const parent = await candidateParent(root);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(parent)) !== parent
  ) {
    throw new Error("Backup CLI candidate storage is not owned by the control account.");
  }
  return parent;
}

function requireId(id: string): void {
  if (!UUID.test(id)) {
    throw new Error("Backup CLI candidate and operation IDs must be UUIDs.");
  }
}

async function runGit(
  command: CommandRunner,
  root: string,
  args: string[],
  readOnly = true,
): Promise<string> {
  const result = await command(["git", "-C", root, ...args], {
    cwd: root,
    timeoutMs: TIMEOUT_MS,
    env: { ...resolveImmutableGenerationEnv(), ...(readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}) },
  });
  if (
    result.code !== 0 ||
    result.killed ||
    result.signal ||
    result.outputLimitExceeded ||
    (result.termination && result.termination !== "exit")
  ) {
    throw new Error(`Backup CLI Git ${args[0]} failed before completion.`);
  }
  return result.stdout.trim();
}

async function inspectCandidate(root: string, sha: string, command: CommandRunner) {
  const metadata = path.join(root, ".git");
  if (!(await fs.lstat(metadata)).isDirectory()) {
    throw new Error("Backup CLI candidate must have independent Git metadata.");
  }
  await assertImmutableGitConfig(root);
  const alternates = await fs
    .readFile(path.join(metadata, "objects", "info", "alternates"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  if (alternates.trim()) {
    throw new Error("Backup CLI candidate borrows another Git object store.");
  }
  if ((await runGit(command, root, ["rev-parse", "HEAD"])) !== sha) {
    throw new Error("Backup CLI candidate source SHA changed.");
  }
  if ((await runGit(command, root, ["status", "--porcelain", "--untracked-files=no"])) !== "") {
    throw new Error("Backup CLI candidate tracked source changed.");
  }
  const errors = await collectGitRuntimeErrors({ root, sha });
  if (errors.length) {
    throw new Error("Backup CLI candidate build identity changed.");
  }
  const built = await readGitRuntimeArtifactIdentity(root);
  if (built.commit !== sha) {
    throw new Error("Backup CLI candidate built SHA changed.");
  }
  const stat = await fs.lstat(root, { bigint: true });
  return {
    rootIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    buildDigest: built.distDigest,
  };
}

/** The installed updater owns preparation; candidate code never handles its own receipt. */
export async function prepareBackupCliCandidate(params: {
  controlRoot: string;
  sha: string;
  operationId: string;
  runCommand?: CommandRunner;
  signal?: AbortSignal;
  onCustody?: (paths: { candidateRoot: string; stagingRoot: string }) => void;
  onPublished?: (receipt: PreparedBackupCli) => void;
}): Promise<PreparedBackupCli> {
  if (process.geteuid?.() === 0) {
    throw new Error("Backup CLI candidates must be built by the service account, not root.");
  }
  if (!SHA.test(params.sha)) {
    throw new Error("Backup CLI preparation requires an exact 40-character commit SHA.");
  }
  requireId(params.operationId);
  params.signal?.throwIfAborted();
  const root = await controlRoot(params.controlRoot);
  const parent = await privateParent(root);
  // A failed publication can be recovered by the same operation ID without a
  // random path that the controller never received.
  const id = params.operationId;
  const destination = path.join(parent, id);
  const staging = path.join(parent, `.prepare-${id}`);
  params.onCustody?.({ candidateRoot: destination, stagingRoot: staging });
  await fs.mkdir(staging, { mode: 0o700 });
  const candidateRoot = path.join(staging, "source");
  const command: CommandRunner =
    params.runCommand ??
    ((argv, options) => runCommandWithTimeout(argv, { ...options, killProcessTree: true }));
  const steps: UpdateStepResult[] = [];
  let published = false;
  let cleanupUncertain = false;
  try {
    const selected = await withGitTargetInspectionRoot(
      {
        root,
        runCommand: command,
        timeoutMs: TIMEOUT_MS,
        temporaryParent: staging,
        onWarning: () => {
          cleanupUncertain = true;
        },
        // A still-registered worktree needs its private repository for recovery.
        retainCleanup: () => cleanupUncertain,
      },
      async (inspectionRoot, inspectCommand) => {
        const inspectStep: StepFactory = (name, argv, cwd, env) => ({
          name,
          argv,
          cwd,
          env,
          runCommand: inspectCommand,
          timeoutMs: TIMEOUT_MS,
          stepIndex: 0,
          totalSteps: 0,
          results: steps,
        });
        const fetched = await fetchGitUpdateTarget({
          root: inspectionRoot,
          channel: "dev",
          devTarget: { mode: "detached", ref: params.sha },
          name: "backup-cli-fetch",
          step: inspectStep,
          workStep: inspectStep,
          steps,
        });
        if (!fetched.ok) {
          throw new Error("Backup CLI target commit could not be inspected.");
        }
        let cleanupWorktree: (() => Promise<boolean>) | undefined;
        let result: Awaited<ReturnType<typeof runGitCandidatePreflight>>;
        let workUncertain = false;
        try {
          result = await runGitCandidatePreflight({
            gitRoot: inspectionRoot,
            artifactRoot: staging,
            targetRevision: params.sha,
            refreshedRemotes: fetched.refreshedRemotes,
            beforeRuntimeVerified: false,
            frozenLockfile: true,
            needsCheckoutMain: false,
            runCommand: inspectCommand,
            timeoutMs: TIMEOUT_MS,
            defaultCommandEnv: process.env,
            steps,
            step: inspectStep,
            workStep: inspectStep,
            beforeCandidate: async (sha) => {
              if (sha !== params.sha) {
                throw new Error("Backup CLI preparation cannot select another commit.");
              }
            },
            validateCandidate: async (built) => {
              if ((await collectGitRuntimeErrors({ root: built, sha: params.sha })).length) {
                throw new Error("Backup CLI build failed runtime identity validation.");
              }
            },
            retainCleanup: (cleanup) => {
              cleanupWorktree = cleanup;
              return true;
            },
            prepareCandidate: async (built) => {
              params.signal?.throwIfAborted();
              // The preflight worktree points at the disposable inspection repository.
              // A transport clone materializes its reachable objects before that owner exits.
              // A detached SHA need not have a named ref in the inspection clone.
              await runGit(
                inspectCommand,
                inspectionRoot,
                ["update-ref", "refs/openclaw/backup-cli-candidate", params.sha],
                false,
              );
              const clone = await runStep(
                inspectStep(
                  "backup-cli-materialize",
                  ["git", "clone", "--no-local", "--no-checkout", inspectionRoot, candidateRoot],
                  staging,
                ),
              );
              if (isFailedUpdateStep(clone)) {
                throw new Error("Backup CLI candidate materialization failed.");
              }
              // Clone's default refspec need not include the private detached target.
              await runGit(
                inspectCommand,
                candidateRoot,
                ["fetch", "--no-tags", inspectionRoot, "refs/openclaw/backup-cli-candidate"],
                false,
              );
              await runGit(
                inspectCommand,
                candidateRoot,
                ["checkout", "--detach", params.sha],
                false,
              );
              await fs.cp(built, candidateRoot, {
                recursive: true,
                verbatimSymlinks: true,
                filter: (file) => file !== path.join(built, ".git"),
              });
              params.signal?.throwIfAborted();
            },
          });
        } catch (error) {
          workUncertain = hasCommandProcessCleanupError(error);
          cleanupUncertain ||= workUncertain;
          throw error;
        } finally {
          if (cleanupWorktree && !workUncertain) {
            try {
              if (!(await cleanupWorktree())) {
                cleanupUncertain = true;
              }
            } catch (error) {
              cleanupUncertain = true;
              throw error;
            }
          }
        }
        if (result.status !== "ok" || result.candidateSha !== params.sha) {
          throw new Error(
            `Backup CLI candidate preflight failed: ${result.status === "ok" ? "wrong SHA" : result.reason}.`,
          );
        }
        return result;
      },
    );
    if (selected.status !== "ok" || cleanupUncertain) {
      throw new Error("Backup CLI preparation did not settle its private inspection cleanup.");
    }
    params.signal?.throwIfAborted();
    const identity = await inspectCandidate(candidateRoot, params.sha, command);
    params.signal?.throwIfAborted();
    const receipt: PreparedBackupCli = {
      kind: "prepared-backup-cli",
      version: 1,
      id,
      operationId: params.operationId,
      sha: params.sha,
      root: destination,
      rootIdentity: identity.rootIdentity,
      buildDigest: identity.buildDigest,
      preparedAtMs: Date.now(),
    };
    const handle = await fs.open(path.join(candidateRoot, ".git", RECEIPT), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    requireDirectorySync(
      await syncDirectory(path.join(candidateRoot, ".git")),
      "Backup CLI receipt",
    );
    params.signal?.throwIfAborted();
    await fs.rename(candidateRoot, destination);
    published = true;
    params.onPublished?.(receipt);
    requireDirectorySync(await syncDirectory(parent), "Backup CLI candidate");
    return receipt;
  } catch (error) {
    cleanupUncertain ||= hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!cleanupUncertain) {
      await fs.rm(staging, { recursive: true, force: true });
    }
    // A published candidate has its own receipt and explicit retirement owner.
    if (!published && cleanupUncertain) {
      process.stderr.write(
        "Backup CLI candidate cleanup is uncertain; retained private staging.\n",
      );
    }
  }
}

/** Read-only identity check. The controller's separate ArtifactHolder owns use. */
export async function verifyBackupCliCandidate(params: {
  controlRoot: string;
  id: string;
  operationId: string;
  runCommand?: CommandRunner;
}): Promise<PreparedBackupCli> {
  requireId(params.id);
  requireId(params.operationId);
  const root = await controlRoot(params.controlRoot);
  const candidate = path.join(await candidateParent(root), params.id);
  const physical = await fs.realpath(candidate);
  if (physical !== candidate || !(await fs.lstat(candidate)).isDirectory()) {
    throw new Error("Backup CLI candidate root changed.");
  }
  const receipt = await readReceipt(candidate, params.id, params.operationId);
  const command: CommandRunner =
    params.runCommand ??
    ((argv, options) => runCommandWithTimeout(argv, { ...options, killProcessTree: true }));
  const identity = await inspectCandidate(candidate, receipt.sha, command);
  if (
    identity.rootIdentity.dev !== receipt.rootIdentity.dev ||
    identity.rootIdentity.ino !== receipt.rootIdentity.ino ||
    identity.buildDigest !== receipt.buildDigest
  ) {
    throw new Error("Backup CLI candidate root or build changed after preparation.");
  }
  return receipt;
}

async function readReceipt(
  candidate: string,
  id: string,
  operationId: string,
  retired = false,
): Promise<PreparedBackupCli> {
  const value: unknown = JSON.parse(
    await fs.readFile(
      path.join(candidate, ".git", retired ? `${RECEIPT}.retired` : RECEIPT),
      "utf8",
    ),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backup CLI candidate receipt is invalid.");
  }
  const receipt = value as PreparedBackupCli;
  if (
    receipt.kind !== "prepared-backup-cli" ||
    receipt.version !== 1 ||
    receipt.id !== id ||
    receipt.operationId !== operationId ||
    receipt.root !== candidate ||
    typeof receipt.sha !== "string" ||
    !SHA.test(receipt.sha) ||
    !Number.isSafeInteger(receipt.preparedAtMs) ||
    receipt.preparedAtMs <= 0 ||
    typeof receipt.buildDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.buildDigest) ||
    !/^\d+$/u.test(receipt.rootIdentity?.dev ?? "") ||
    !/^\d+$/u.test(receipt.rootIdentity?.ino ?? "")
  ) {
    throw new Error("Backup CLI candidate receipt does not match its selected owner.");
  }
  return receipt;
}

/** Invalidate admission before physical cleanup; only the controller releases its use holder. */
export async function retireBackupCliCandidate(params: {
  controlRoot: string;
  id: string;
  operationId: string;
  runCommand?: CommandRunner;
  acquireOwnership?: (root: string) => Promise<FileLockHandle>;
}): Promise<void> {
  requireId(params.id);
  requireId(params.operationId);
  const control = await controlRoot(params.controlRoot);
  const candidate = path.join(await candidateParent(control), params.id);
  if ((await fs.realpath(candidate)) !== candidate || !(await fs.lstat(candidate)).isDirectory()) {
    throw new Error("Backup CLI candidate root changed.");
  }
  const retiredPath = path.join(candidate, ".git", `${RECEIPT}.retired`);
  const alreadyRetired = await fs.access(retiredPath).then(
    () => true,
    () => false,
  );
  const receipt = alreadyRetired
    ? await readReceipt(candidate, params.id, params.operationId, true)
    : await verifyBackupCliCandidate(params);
  let acquire = params.acquireOwnership;
  if (!acquire) {
    const lockModule: unknown = await import(
      pathToFileURL(path.join(control, "scripts", "lib", "dist-artifact-lock.mts")).href
    );
    if (
      !lockModule ||
      typeof lockModule !== "object" ||
      !("acquireDistArtifactOwnership" in lockModule) ||
      typeof lockModule.acquireDistArtifactOwnership !== "function"
    ) {
      throw new Error("Installed candidate artifact owner is unavailable.");
    }
    acquire = lockModule.acquireDistArtifactOwnership as (root: string) => Promise<FileLockHandle>;
  }
  const lock = await acquire(receipt.root);
  try {
    if (alreadyRetired) {
      await readReceipt(candidate, params.id, params.operationId, true);
    } else {
      await verifyBackupCliCandidate(params);
      await fs.rename(path.join(candidate, ".git", RECEIPT), retiredPath);
    }
  } finally {
    await lock.release();
  }
  // The receipt is gone before this point, so a new controller verification refuses it.
  const stat = await fs.lstat(candidate, { bigint: true });
  if (`${stat.dev}:${stat.ino}` !== `${receipt.rootIdentity.dev}:${receipt.rootIdentity.ino}`) {
    throw new Error("Backup CLI candidate root changed before retirement cleanup.");
  }
  await fs.rm(candidate, { recursive: true, force: false });
}
