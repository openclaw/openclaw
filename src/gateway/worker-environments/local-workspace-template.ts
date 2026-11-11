import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex as digest } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml } from "yaml";
import {
  prepareSandboxDependencyTemplate,
  resolveSandboxDependencyTemplateIdentity,
} from "../../agents/sandbox/dependency-template.js";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { WORKTREE_SETUP_HEADROOM_BYTES } from "../../agents/worktrees/capacity.js";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { hasWorktreeUnknownOutcome } from "../../agents/worktrees/errors.js";
import { detectWorktreeFilesystemBackend } from "../../agents/worktrees/filesystem-backend.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import { prepareWorktreeTemplate } from "../../agents/worktrees/template-cache.js";
import {
  readTemplateManifest,
  prepareTemplateManifest,
} from "../../agents/worktrees/template-registry-async.js";
import type { WorktreeTemplateRecord } from "../../agents/worktrees/template-registry.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { prepareLocalWorkspaceCheckout } from "./local-workspace-checkout.js";
import { captureTemplateWorkspaceManifest } from "./workspace-manifest-worker.js";
import { buildCacheInputPaths, WORKSPACE_PATH_EXCLUSIONS_JS } from "./workspace-path-exclusions.js";

const log = createSubsystemLogger("agents/worktrees");
const TEMPLATE_PHASE = "attempt.setup.sandbox.workspace_selection.prepare.reconcile.template";

async function hasContainedVirtualStore(directory: string, workdir: string): Promise<boolean> {
  try {
    const root = await fsRoot(directory);
    const { buffer } = await root.read("node_modules/.modules.yaml", {
      symlinks: "reject",
      maxBytes: 1024 * 1024,
    });
    const manifest: unknown = parseYaml(buffer.toString("utf8"));
    if (!isRecord(manifest) || typeof manifest.virtualStoreDir !== "string") {
      return false;
    }
    // pnpm records this relative to node_modules, or as an absolute guest path.
    const modules = path.posix.resolve(workdir, "node_modules");
    const relative = path.posix.relative(
      modules,
      path.posix.resolve(modules, manifest.virtualStoreDir),
    );
    return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
  } catch {
    return false;
  }
}

/** Only dependencies may survive installation; repository setup outputs remain private. */
async function validateTemplate(
  directory: string,
  commit: string,
  guard: Pick<WorktreeAllocationGuard, "signal" | "commitGuard">,
  mode: "validate" | "dependencies" | "source-only" = "validate",
) {
  return await withWorktreeGitConfig(
    directory,
    true,
    { signal: guard.signal, beforeRun: guard.commitGuard },
    async (git) => {
      const result = await git.run(
        directory,
        [
          "--no-optional-locks",
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=normal",
          "--ignored=matching",
        ],
        {
          signal: guard.signal,
          beforeRun: guard.commitGuard,
          killProcessTree: true,
        },
      );
      const fields = result.stdout.split("\0");
      if (
        result.code !== 0 ||
        result.termination !== "exit" ||
        result.stdoutTruncatedBytes ||
        fields.pop() !== ""
      ) {
        return false;
      }
      const heads = fields.filter((field) => field.startsWith("# branch.oid "));
      if (heads.length !== 1 || heads[0] !== `# branch.oid ${commit}`) {
        return false;
      }
      for (const field of fields) {
        if (field.startsWith("# ")) {
          continue;
        }
        // Tracked source, including the frozen lockfile and ignore rules, is immutable.
        if (!field.startsWith("! ") && !field.startsWith("? ")) {
          return false;
        }
        const relative = field.slice(2);
        const parts = relative.replace(/\/$/u, "").split("/");
        if (
          parts.some((part) => !part || part === "." || part === "..") ||
          path.isAbsolute(relative)
        ) {
          return false;
        }
        const target = path.join(directory, ...parts);
        const modulesIndex = parts.indexOf("node_modules");
        if (modulesIndex !== -1 && mode !== "source-only") {
          const modules = await fs.lstat(path.join(directory, ...parts.slice(0, modulesIndex + 1)));
          // Git can report the directory, ignored children, or unignored packages.
          // The generated directory boundary owns eligibility, not its ignore spelling.
          if (!modules.isDirectory()) {
            return false;
          }
          continue;
        }
        if (mode === "validate") {
          return false;
        }
        guard.commitGuard();
        await fs.rm(target, { recursive: true, force: true });
      }
      return true;
    },
  );
}

type LocalWorkspaceTemplateParams = {
  source: string;
  repoRoot: string;
  baseCommit: string;
  temporaryRoot: string;
  templateRoot: string;
  env: NodeJS.ProcessEnv;
  sandbox: SandboxConfig;
  buildCacheInputs?: string[];
  guard: Pick<WorktreeAllocationGuard, "commitGuard" | "rollbackGuard" | "requireDiskSpace"> & {
    signal: AbortSignal;
  };
};

/** The returned template retains its generation until the caller settles its clone. */
export async function prepareLocalWorkspaceTemplate(params: LocalWorkspaceTemplateParams) {
  const { guard } = params;
  const buildCacheInputs =
    params.buildCacheInputs && [...buildCacheInputPaths(params.buildCacheInputs)].toSorted();
  const policyKey = digest(
    JSON.stringify(["template-manifest-v1", WORKSPACE_PATH_EXCLUSIONS_JS, buildCacheInputs]),
  );
  let manifest: { rawManifest: string; manifestRef: string } | undefined;
  let previousGeneration: WorktreeTemplateRecord | undefined;
  let changedPaths: string[] | undefined;
  const prepareManifest = async (
    record: WorktreeTemplateRecord,
    options: Pick<WorktreeAllocationGuard, "commitGuard" | "signal">,
  ) => {
    if (!buildCacheInputs) {
      return;
    }
    manifest = await prepareTemplateManifest(
      record,
      policyKey,
      async () => {
        const prior =
          previousGeneration &&
          changedPaths &&
          !changedPaths.some((entry) => path.posix.basename(entry) === ".gitattributes") &&
          (await readTemplateManifest(previousGeneration, policyKey));
        return await timeWorktreePreparationPhase("snapshot", () =>
          captureTemplateWorkspaceManifest(
            {
              root: record.path,
              baseCommit: record.sourceCommit,
              buildCacheInputs,
              previous: prior && changedPaths ? { ...prior, changedPaths } : undefined,
            },
            options.signal,
          ),
        );
      },
      options.signal,
    );
    options.commitGuard();
  };
  const backend = await detectWorktreeFilesystemBackend(params.temporaryRoot, guard);
  if (!backend) {
    return undefined;
  }
  const gitOptions = { signal: guard.signal, beforeRun: guard.commitGuard, killProcessTree: true };
  const lockfile = await runGit(
    params.source,
    ["show", `${params.baseCommit}:pnpm-lock.yaml`],
    gitOptions,
  );
  if (lockfile.code !== 0 || lockfile.stdoutTruncatedBytes) {
    log.debug(
      "sandbox dependency template skipped: no complete pnpm lockfile at the selected commit",
    );
    return undefined;
  }
  const identity = await resolveSandboxDependencyTemplateIdentity(params.sandbox, {
    signal: guard.signal,
    assertCurrent: guard.commitGuard,
  });
  if (!identity) {
    log.debug("sandbox dependency template skipped: local image identity unavailable");
    return undefined;
  }
  const commonDir = path.resolve(
    params.source,
    await requireGit(params.source, ["rev-parse", "--git-common-dir"], gitOptions),
  );
  const prepareSource = async (
    directory: string,
    templateGuard: typeof guard,
    retainedCommit?: string,
  ) => {
    await guard.requireDiskSpace(
      [{ path: params.templateRoot, bytes: WORKTREE_SETUP_HEADROOM_BYTES }],
      "sandbox dependency template",
    );
    if (!retainedCommit) {
      await backend.createTemplate(directory, templateGuard);
    }
    await timeWorktreePreparationPhase("checkout", () =>
      prepareLocalWorkspaceCheckout({
        source: params.source,
        destination: directory,
        temporaryRoot: params.temporaryRoot,
        baseCommit: params.baseCommit,
        retainedCommit,
        branch: "openclaw-template",
        signal: templateGuard.signal,
        assertCurrent: templateGuard.commitGuard,
      }),
    );
  };
  const prepare = async (
    directory: string,
    templateOptions: WorktreeAllocationGuard,
    retainedCommit?: string,
  ) => {
    using phases = observeDiagnosticsTimelinePhases(`${TEMPLATE_PHASE}.build`);
    const templateGuard = {
      ...guard,
      ...templateOptions,
      signal: templateOptions.signal ?? guard.signal,
    };
    await prepareSource(directory, templateGuard, retainedCommit);
    const result = await prepareSandboxDependencyTemplate({
      directory,
      cfg: params.sandbox,
      // Refreshes retain the template row, but must not reuse its retired builder.
      scopeKey: randomUUID(),
      identity,
      signal: templateGuard.signal,
      assertCurrent: templateGuard.commitGuard,
      rollbackGuard: templateOptions.rollbackGuard,
    });
    phases.mark(`${TEMPLATE_PHASE}.validate`);
    const contained =
      result.installed && (await hasContainedVirtualStore(directory, identity.docker.workdir));
    templateGuard.commitGuard();
    const valid = await validateTemplate(
      directory,
      params.baseCommit,
      templateGuard,
      contained ? "dependencies" : "source-only",
    );
    if (contained && valid) {
      log.info("sandbox dependency template prepared for the selected commit");
      return;
    }
    const reason = result.installed
      ? contained
        ? "installation changed tracked source"
        : "pnpm virtual store is outside node_modules or unavailable"
      : result.reason;
    log.warn(`sandbox dependency template using source-only fallback: ${reason}`);
    // The builder has retired. Reuse its clean source only after removing every
    // generated output; changed or unverified tracked bytes still need a fresh checkout.
    if (valid) {
      return;
    }
    templateGuard.commitGuard();
    phases.mark(`${TEMPLATE_PHASE}.rebuild`);
    await fs.rm(directory, { recursive: true, force: true });
    await prepareSource(directory, templateGuard);
  };
  const record = await prepareWorktreeTemplate({
    env: params.env,
    now: Date.now,
    options: guard,
    cacheKey: digest(`sandbox-v1\n${commonDir}\n${params.templateRoot}\n${identity.key}`),
    contentKey: digest(`${params.baseCommit}\n${digest(lockfile.stdout)}\n${identity.key}`),
    repoRoot: params.repoRoot,
    commonDir,
    worktreeRoot: params.templateRoot,
    sourceCommit: params.baseCommit,
    backend: `sandbox-${backend.id}`,
    requireSpace: () =>
      guard.requireDiskSpace(
        [{ path: params.templateRoot, bytes: WORKTREE_SETUP_HEADROOM_BYTES }],
        "sandbox dependency template",
      ),
    validate: (existing, templateOptions) =>
      validateTemplate(existing.path, existing.sourceCommit, templateOptions),
    refresh: async (existing, preparing, templateOptions) => {
      previousGeneration = existing;
      // Retain exact commit identity: lifecycle scripts and local packages can consume
      // any source file. Reinstall after advancing; only the full checkout is skipped.
      const changed = await withWorktreeGitConfig(
        params.source,
        true,
        { ...gitOptions, signal: templateOptions.signal, beforeRun: templateOptions.commitGuard },
        (git) =>
          git.run(
            params.source,
            [
              "diff-tree",
              "--no-commit-id",
              "-r",
              "--no-renames",
              "--name-only",
              "-z",
              existing.sourceCommit,
              params.baseCommit,
              "--",
            ],
            { signal: templateOptions.signal, killProcessTree: true },
          ),
      );
      changedPaths =
        changed.code === 0 && changed.termination === "exit" && !changed.stdoutTruncatedBytes
          ? changed.stdout.split("\0").filter(Boolean)
          : undefined;
      if (
        !changedPaths ||
        changedPaths.some(
          (entry) => entry === "pnpm-lock.yaml" || path.posix.basename(entry) === ".gitattributes",
        )
      ) {
        return false;
      }
      await backend.cloneTemplate(existing.path, preparing.path, templateOptions);
      await prepare(preparing.path, templateOptions, existing.sourceCommit);
      await prepareManifest(preparing, templateOptions);
      return true;
    },
    prepare: async (preparing, templateOptions) => {
      await prepare(preparing.path, templateOptions);
      await prepareManifest(preparing, templateOptions);
    },
  });
  if (!record) {
    return undefined;
  }
  try {
    if (!manifest) {
      await prepareManifest(record, guard);
    }
    return { record, backend, manifest };
  } catch (error) {
    await record.release(error);
    throw error;
  }
}

/** The caller holds worktree mutation before projection custody, matching removal's lock order. */
export async function cloneLocalWorkspaceTemplate(
  params: LocalWorkspaceTemplateParams & { branch: string; destination: string },
) {
  using phases = observeDiagnosticsTimelinePhases(`${TEMPLATE_PHASE}.select`);
  const prepared = await timeWorktreePreparationPhase("templatePrepare", () =>
    prepareLocalWorkspaceTemplate({ ...params, buildCacheInputs: params.buildCacheInputs ?? [] }),
  );
  if (!prepared) {
    return false;
  }
  const { record, backend } = prepared;
  const { guard } = params;
  let outcome: unknown;
  try {
    phases.mark(`${TEMPLATE_PHASE}.clone`);
    guard.commitGuard();
    await guard.requireDiskSpace(
      [
        {
          path: params.destination,
          bytes:
            backend.id === "btrfs"
              ? backend.estimateCloneBytes(0, 0)
              : WORKTREE_SETUP_HEADROOM_BYTES,
        },
      ],
      "sandbox workspace clone",
    );
    try {
      await timeWorktreePreparationPhase("templateApply", () =>
        backend.cloneTemplate(record.path, params.destination, guard),
      );
    } catch (error) {
      if (hasWorktreeUnknownOutcome(error)) {
        throw error;
      }
      guard.commitGuard();
      await fs.rm(params.destination, { recursive: true, force: true });
      log.warn("sandbox dependency snapshot unavailable; using source-only checkout");
      return false;
    }
    // This .git was host-created and read-only throughout installation; guests only
    // receive the independent cloned metadata after its session branch is selected.
    await requireGit(params.destination, ["branch", "-m", params.branch], {
      signal: guard.signal,
      beforeRun: guard.commitGuard,
      killProcessTree: true,
    });
    return prepared.manifest!;
  } catch (error) {
    outcome = error;
    throw error;
  } finally {
    phases.mark(`${TEMPLATE_PHASE}.release`);
    await record.release(outcome);
  }
}
