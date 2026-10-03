import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateImmutableInstall } from "../../packages/gateway-protocol/src/schema/config.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import type {
  ImmutableInstallDescriptor,
  ImmutableInstallRecord,
} from "./update-immutable-install-schema.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import type { CommandRunner } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const SHA = /^[a-f0-9]{40}$/u;
const SOURCE = "https://github.com/openclaw/openclaw.git";

function directoryIdentity(file: string): string {
  const stat = fsSync.lstatSync(file);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`Immutable installation directory must be root-owned and protected: ${file}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

function readLayout(root: string) {
  if (fsSync.realpathSync(root) !== root) {
    throw new Error("Immutable installation must have a canonical physical root.");
  }
  const rootIdentity = directoryIdentity(root);
  const releases = path.join(root, "releases");
  const releasesIdentity = directoryIdentity(releases);
  const pointer = path.join(root, "current");
  const stat = fsSync.lstatSync(pointer);
  const target = stat.isSymbolicLink() ? fsSync.readlinkSync(pointer) : "";
  const generationPath = path.resolve(root, target);
  const sha = path.basename(generationPath);
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    !SHA.test(sha) ||
    path.dirname(generationPath) !== releases
  ) {
    throw new Error(
      "Immutable current must select a root-owned direct releases/<40-hex SHA> generation.",
    );
  }
  const identity = directoryIdentity(generationPath);
  if (
    fsSync.realpathSync(pointer) !== generationPath ||
    rootIdentity.split(":")[0] !== releasesIdentity.split(":")[0] ||
    identity.split(":")[0] !== releasesIdentity.split(":")[0]
  ) {
    throw new Error("Immutable release layout must be contained on one filesystem.");
  }
  return {
    rootIdentity,
    releasesIdentity,
    current: { sha, path: generationPath, identity, pointerIdentity: `${stat.dev}:${stat.ino}` },
  };
}

function assertDescriptorCurrent(descriptor: ImmutableInstallDescriptor): void {
  const layout = readLayout(descriptor.root);
  if (
    layout.rootIdentity !== descriptor.rootIdentity ||
    layout.releasesIdentity !== descriptor.releasesIdentity ||
    layout.current.sha !== descriptor.current.sha ||
    layout.current.path !== descriptor.current.path ||
    layout.current.identity !== descriptor.current.identity ||
    layout.current.pointerIdentity !== descriptor.current.pointerIdentity ||
    packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity
  ) {
    throw new Error("Immutable installation changed since adoption; current was not modified.");
  }
}

function project(record: ImmutableInstallRecord): UpdateImmutableInstall {
  const { descriptor, prepared } = record;
  return {
    root: descriptor.root,
    currentSha: descriptor.current.sha,
    currentPath: descriptor.current.path,
    ...(prepared
      ? {
          prepared: {
            sha: prepared.sha,
            path: prepared.path,
            buildDigest: prepared.buildDigest,
            preparedAtMs: prepared.preparedAtMs,
          },
        }
      : {}),
  };
}

async function installationRoot(input: string): Promise<string | null> {
  const root = path.resolve(input);
  if (
    path.basename(path.dirname(root)) === "releases" &&
    /^[a-f0-9]{40}$/iu.test(path.basename(root))
  ) {
    return path.dirname(path.dirname(root));
  }
  if (path.basename(root) === "current") {
    const stat = await fs.lstat(root).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      return path.dirname(root);
    }
  }
  const current = await fs.lstat(path.join(root, "current")).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return null;
    }
    throw error;
  });
  if (!current) {
    return null;
  }
  const releases = await fs.lstat(path.join(root, "releases")).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  return releases ? root : null;
}

/** Shape is only a hint. Unadopted releases must never fall through to mutable Git. */
export async function inspectImmutableInstall(
  root: string,
): Promise<UpdateImmutableInstall | null> {
  const installation = await installationRoot(root);
  if (!installation) {
    return null;
  }
  const record = await readImmutableInstallRecord(installation);
  if (!record) {
    throw new Error(
      "Immutable release layout is not adopted. Use openclaw update adopt-immutable after its previous updater has stopped.",
    );
  }
  assertDescriptorCurrent(record.descriptor);
  return project(record);
}

function requireUpdater(): void {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) {
    throw new Error(
      "Immutable preparation and adoption require the root updater on Linux; the current Gateway remains running.",
    );
  }
}

async function withPreparationOwner<T>(
  root: string,
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const { acquireFileLock } = await import("./file-lock.js");
  const rootIdentity = directoryIdentity(root);
  const lock = await acquireFileLock(path.join(root, ".openclaw-immutable-prepare"), {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: Number.MAX_SAFE_INTEGER,
    staleRecovery: "fail-closed",
  });
  const identity = fsSync.lstatSync(lock.lockPath);
  const assertCurrent = () => {
    const current = fsSync.lstatSync(lock.lockPath);
    if (
      directoryIdentity(root) !== rootIdentity ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error("Immutable preparation ownership changed.");
    }
  };
  let settled = true;
  try {
    return await run(assertCurrent);
  } catch (error) {
    settled = !hasCommandProcessCleanupError(error);
    if (!settled) {
      throw new Error(
        `Preparation processes did not settle. Inspect the retained lock ${lock.lockPath} before another update.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (settled) {
      await lock.release();
    }
  }
}

export async function adoptImmutableInstall(params: {
  root: string;
  service: ImmutableInstallDescriptor["service"];
  runtime: string;
  previousUpdaterStopped: true;
}): Promise<UpdateImmutableInstall> {
  requireUpdater();
  const { installImmutableLauncher, verifyImmutableGeneration } =
    await import("./update-immutable-generation.js");
  const { verifyImmutableService } = await import("./update-immutable-service.js");
  const { ImmutableInstallDescriptorSchema } = await import("./update-immutable-install-schema.js");
  if (!params.previousUpdaterStopped) {
    throw new Error("The previous updater must be stopped before adoption.");
  }
  const root = await fs.realpath(params.root);
  return withPreparationOwner(root, async (assertOwner) => {
    const layout = readLayout(root);
    const runtime = await fs.realpath(params.runtime);
    const runtimeStat = await fs.lstat(runtime);
    if (
      !runtimeStat.isFile() ||
      runtimeStat.uid !== 0 ||
      (runtimeStat.mode & 0o022) !== 0 ||
      runtime.startsWith(`${root}/`)
    ) {
      throw new Error("Immutable installation requires a protected external Node runtime.");
    }
    for (let parent = path.dirname(runtime); ; parent = path.dirname(parent)) {
      directoryIdentity(parent);
      if (parent === path.dirname(parent)) {
        break;
      }
    }
    const generation = await verifyImmutableGeneration(layout.current.path, layout.current.sha);
    const descriptor: ImmutableInstallDescriptor = {
      version: 1,
      kind: "immutable",
      root,
      ...layout,
      current: { ...layout.current, buildDigest: generation.buildDigest },
      service: params.service,
      runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
      source: SOURCE,
    };
    ImmutableInstallDescriptorSchema.parse(descriptor);
    const assertCurrent = () => {
      assertOwner();
      assertDescriptorCurrent(descriptor);
    };
    await verifyImmutableService(descriptor.service, root, descriptor.current.path, runtime);
    assertCurrent();
    await installImmutableLauncher({ root, runtimePath: runtime });
    assertCurrent();
    const { createImmutableInstallRecord } =
      await import("./package-update-activation-immutable.js");
    return project(createImmutableInstallRecord(descriptor, assertCurrent));
  });
}

export type ImmutableUpdateResult = {
  status: "prepared" | "already-current" | "dry-run" | "error";
  reason?: string;
  installation: UpdateImmutableInstall;
  targetSha?: string;
  steps: UpdateStepResult[];
  warnings: string[];
};

/** Prepare only. Pointer publication, Doctor, drain, and service activation belong to slice 2. */
export async function prepareImmutableUpdate(params: {
  root: string;
  sha?: string;
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<ImmutableUpdateResult> {
  const installation = await inspectImmutableInstall(params.root);
  if (!installation) {
    throw new Error("Installation is not an adopted immutable release.");
  }
  const steps: UpdateStepResult[] = [];
  const warnings: string[] = [];
  let targetSha: string | undefined;
  const result = (
    status: ImmutableUpdateResult["status"],
    reason?: string,
  ): ImmutableUpdateResult => ({ status, reason, installation, targetSha, steps, warnings });
  try {
    if (params.sha !== undefined && !SHA.test(params.sha)) {
      throw new Error("--sha requires a full lowercase 40-hex commit SHA.");
    }
    const { buildUpdateCommandRunner, runStep } = await import("./update-runner-command.js");
    const { resolveImmutableGenerationEnv, sealImmutableGeneration, verifyImmutableGeneration } =
      await import("./update-immutable-generation.js");
    const runner = await buildUpdateCommandRunner();
    const defaultCommandEnv = resolveImmutableGenerationEnv(runner.defaultCommandEnv);
    const runCommand: CommandRunner = (argv, options) =>
      runner.runCommand(argv, {
        ...options,
        env: resolveImmutableGenerationEnv({ ...defaultCommandEnv, ...options.env }),
      });
    const timeoutMs = params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS;
    const step: StepFactory = (name, argv, cwd, env) => ({
      name,
      argv,
      cwd,
      env,
      runCommand,
      timeoutMs,
      results: steps,
      stepIndex: steps.length,
      totalSteps: 0,
    });
    const command = async (name: string, argv: string[], cwd: string) => {
      const outcome = await runStep(step(name, argv, cwd));
      if (outcome.exitCode !== 0 || (outcome.termination && outcome.termination !== "exit")) {
        throw new Error(`${name} failed; current was not modified.`);
      }
      return outcome.stdoutTail?.trim() ?? "";
    };
    targetSha = params.sha;
    if (!targetSha) {
      const head = await command(
        "immutable-resolve-main",
        ["git", "ls-remote", "--exit-code", SOURCE, "refs/heads/main"],
        installation.root,
      );
      const match = head.match(/^([a-f0-9]{40})\s+refs\/heads\/main$/u);
      if (!match?.[1]) {
        throw new Error("Official main did not resolve to one exact commit.");
      }
      targetSha = match[1];
    }
    if (params.dryRun) {
      return result("dry-run", "preparation-only; activation unavailable");
    }
    requireUpdater();
    const { collectGitRuntimeErrors } = await import("./update-git-runtime.js");
    const { verifyImmutableService } = await import("./update-immutable-service.js");
    const { runGitCandidatePreflight } = await import("./update-runner-git-preflight.js");
    const { readGitTargetSchemaVersions } = await import("./update-runner-git-target.js");
    const selectedSha = targetSha;
    return await withPreparationOwner(installation.root, async (assertOwner) => {
      const record = await readImmutableInstallRecord(installation.root);
      if (!record) {
        throw new Error("Immutable adoption record disappeared.");
      }
      const descriptor = record.descriptor;
      if ((await fs.realpath(process.execPath)) !== descriptor.runtime.path) {
        throw new Error(
          `Run preparation with the adopted Node executable: ${descriptor.runtime.path}`,
        );
      }
      const assertCurrent = () => {
        assertOwner();
        assertDescriptorCurrent(descriptor);
      };
      assertCurrent();
      await verifyImmutableService(
        descriptor.service,
        descriptor.root,
        descriptor.current.path,
        descriptor.runtime.path,
      );
      const current = await verifyImmutableGeneration(
        descriptor.current.path,
        descriptor.current.sha,
        runCommand,
      );
      if (current.buildDigest !== descriptor.current.buildDigest) {
        throw new Error("Current sealed generation has changed since adoption.");
      }
      assertCurrent();
      if (selectedSha === descriptor.current.sha) {
        return result("already-current");
      }
      const destination = path.join(descriptor.root, "releases", selectedSha);
      if (
        await fs.lstat(destination).then(
          () => true,
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return false;
            }
            throw error;
          },
        )
      ) {
        if (record.prepared?.sha !== selectedSha) {
          throw new Error(
            "Generation already exists without a matching preparation receipt; preserved for inspection.",
          );
        }
        const existing = await verifyImmutableGeneration(destination, selectedSha, runCommand);
        if (
          existing.identity !== record.prepared.identity ||
          existing.buildDigest !== record.prepared.buildDigest
        ) {
          throw new Error(
            "Existing prepared generation differs from its receipt; preserved for inspection.",
          );
        }
        assertCurrent();
        return { ...result("prepared", "activation unavailable"), installation: project(record) };
      }
      assertCurrent();
      const stage = await fs.mkdtemp(path.join(descriptor.root, ".openclaw-immutable-"));
      let cleanupUncertain = false;
      try {
        const source = path.join(stage, "source");
        await command(
          "immutable-clone",
          ["git", "clone", "--no-checkout", "--single-branch", "--branch", "main", SOURCE, source],
          stage,
        );
        await command(
          "immutable-official-ancestry",
          [
            "git",
            "-C",
            source,
            "merge-base",
            "--is-ancestor",
            selectedSha,
            "refs/remotes/origin/main",
          ],
          source,
        );
        const metadata = await readGitTargetSchemaVersions({
          runCommand,
          root: source,
          revision: selectedSha,
          timeoutMs,
        });
        if (metadata.status !== "ok" || !metadata.schemaVersions) {
          throw new Error("Candidate schema metadata is unreadable.");
        }
        let prepared: ImmutableInstallRecord["prepared"] = null;
        const preflight = await runGitCandidatePreflight({
          gitRoot: source,
          artifactRoot: stage,
          targetRevision: selectedSha,
          refreshedRemotes: ["origin"],
          beforeRuntimeVerified: false,
          frozenLockfile: true,
          needsCheckoutMain: false,
          runCommand,
          timeoutMs,
          defaultCommandEnv: {
            ...defaultCommandEnv,
            PATH: `${path.dirname(descriptor.runtime.path)}${path.delimiter}${defaultCommandEnv?.PATH ?? process.env.PATH ?? ""}`,
          },
          steps,
          step,
          workStep: step,
          workTimeoutMs: params.timeoutMs,
          beforeCandidate: async (sha) => {
            assertCurrent();
            if (sha !== selectedSha) {
              throw new Error("Immutable preparation cannot fall back to another commit.");
            }
          },
          validateCandidate: async (root) => {
            const errors = await collectGitRuntimeErrors({ root, sha: selectedSha });
            if (errors.length) {
              throw new Error(errors.join("; "));
            }
          },
          prepareCandidate: async (built) => {
            const candidate = path.join(stage, "generation");
            await command(
              "immutable-independent-git",
              ["git", "clone", "--no-hardlinks", "--no-checkout", source, candidate],
              stage,
            );
            await command(
              "immutable-exact-checkout",
              ["git", "-C", candidate, "checkout", "--detach", selectedSha],
              candidate,
            );
            // Materialize pnpm hardlinks before sealing, preserving its shared store.
            await fs.cp(built, candidate, {
              recursive: true,
              verbatimSymlinks: true,
              filter: (file) => file !== path.join(built, ".git"),
            });
            await verifyImmutableGeneration(candidate, selectedSha, runCommand, { sealed: false });
            await sealImmutableGeneration(candidate);
            const verified = await verifyImmutableGeneration(candidate, selectedSha, runCommand);
            await verifyImmutableService(
              descriptor.service,
              descriptor.root,
              descriptor.current.path,
              descriptor.runtime.path,
            );
            assertCurrent();
            // Native publishers hold this lock; preexisting generations are never rebuilt.
            if (fsSync.existsSync(destination)) {
              throw new Error("Generation publication conflict; existing generation preserved.");
            }
            await fs.rename(candidate, destination);
            requireDirectorySync(
              await syncDirectory(path.dirname(destination)),
              "Immutable releases",
            );
            assertCurrent();
            prepared = {
              sha: selectedSha,
              path: destination,
              ...verified,
              preparedAtMs: Date.now(),
              schemaVersions: metadata.schemaVersions,
            };
          },
        });
        if (preflight.status !== "ok" || !prepared) {
          throw new Error(
            preflight.status === "ok"
              ? "Candidate preparation did not produce a generation."
              : preflight.reason,
          );
        }
        assertCurrent();
        const { recordImmutablePreparedGeneration } =
          await import("./package-update-activation-immutable.js");
        const recorded = recordImmutablePreparedGeneration(record, prepared, assertCurrent);
        return { ...result("prepared", "activation unavailable"), installation: project(recorded) };
      } catch (error) {
        cleanupUncertain = hasCommandProcessCleanupError(error);
        throw error;
      } finally {
        assertCurrent();
        if (cleanupUncertain) {
          warnings.push(`Preparation processes did not settle; retained ${stage} for inspection.`);
        } else {
          await fs.rm(stage, { recursive: true, force: true }).catch(() => {
            warnings.push(`Preparation scratch retained at ${stage}; current is unchanged.`);
          });
        }
      }
    });
  } catch (error) {
    return result(
      "error",
      error instanceof Error
        ? error.message
        : "Immutable preparation failed; current was not modified.",
    );
  }
}
