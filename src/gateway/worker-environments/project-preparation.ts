import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { requireGit } from "../../agents/worktrees/git.js";
import { normalizeCloudRepo } from "../../config/cloud-worker-project-profiles.js";
import { sha256File } from "../../infra/directory-durability.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { WorkerRecipePreparation } from "../../plugins/capability-provider.types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { resolveEnvironmentRecipe, type EnvironmentRecipe } from "./environment-recipe.js";
import { createProjectSeedScript } from "./project-seed-script.js";
import {
  createProjectSetupScript,
  type PreparedProjectVerification,
} from "./project-setup-script.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import {
  prepareWorkerWorkspaceGitPack,
  workerProjectSeedKey,
  type WorkerLocalProjectSnapshot,
  type WorkerProjectSnapshot,
} from "./workspace-git-base.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;
type PreparationResult = Awaited<ReturnType<ProjectPreparation["prepare"]>>;

const RecipePreparation = z.object({
  source: z.enum(["devcontainer", "script", "detected", "none"]),
  ignoredPropertiesNote: z.string().optional(),
  note: z.string().optional(),
  phaseDurationsMs: z
    .object({
      retainedGit: z.number().int().nonnegative().optional(),
      retainedManifest: z.number().int().nonnegative().optional(),
      inspection: z.number().int().nonnegative().optional(),
      seedPreparation: z.number().int().nonnegative().optional(),
      seedTransfer: z.number().int().nonnegative().optional(),
      seedVerification: z.number().int().nonnegative().optional(),
      seedCheckout: z.number().int().nonnegative().optional(),
      seedManifest: z.number().int().nonnegative().optional(),
      gitUpdate: z.number().int().nonnegative().optional(),
      toolchainPreparation: z.number().int().nonnegative().optional(),
      preparedManifest: z.number().int().nonnegative().optional(),
      onCreate: z.number().int().nonnegative().optional(),
      updateContent: z.number().int().nonnegative().optional(),
      detectedInstall: z.number().int().nonnegative().optional(),
    })
    .optional(),
  failure: z
    .object({
      reason: z.string(),
      outputTail: z
        .string()
        .refine((text) => Buffer.byteLength(text) <= 16384)
        .optional(),
    })
    .optional(),
});

export async function readWorkerProjectEnvironmentRecipe(
  project: WorkerLocalProjectSnapshot,
  signal?: AbortSignal,
): Promise<EnvironmentRecipe> {
  return resolveEnvironmentRecipe(async (file) => {
    const tree = await requireGit(project.root, ["ls-tree", "-z", project.baseCommit, "--", file], {
      signal,
      timeoutMs: 30_000,
    });
    const entry = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t[^\0]+\0$/u.exec(tree);
    if (!entry?.[2]) {
      return undefined;
    }
    const blob = entry[2];
    const content =
      file.endsWith("devcontainer.json") || file === "package.json"
        ? await requireGit(project.root, ["cat-file", "blob", blob], { signal, timeoutMs: 30_000 })
        : undefined;
    return {
      blob,
      executable: entry[1] === "100755",
      ...(content !== undefined ? { content } : {}),
    };
  });
}

export function readWorkerProjectSnapshot(value: unknown): WorkerProjectSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value) && value.source !== undefined) {
    return readRepositoryWorkerProjectSnapshot(value);
  }
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.key) ||
    typeof value.baseCommit !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.baseCommit) ||
    (value.label !== undefined && typeof value.label !== "string") ||
    typeof value.root !== "string" ||
    value.root.length > 4096 ||
    !path.isAbsolute(value.root)
  ) {
    throw new Error("Worker environment has an invalid project preparation snapshot");
  }
  return {
    key: value.key,
    root: value.root,
    baseCommit: value.baseCommit,
    ...(value.label !== undefined ? { label: value.label } : {}),
  };
}

export function createWorkerProjectPreparation(params: {
  project: WorkerProjectSnapshot;
  namespace: string;
  preparation?: {
    key: string;
    cacheKey: string;
    purpose: "session" | "reserve";
    demandAtMs: number;
    setupRecipe?: string;
    runSetupScript?: boolean;
    recipe?: EnvironmentRecipe;
  };
  setupAuthorized?: boolean;
  snapshotStart?: true;
  revalidateRepositorySource?: (signal: AbortSignal) => Promise<void>;
  prepareRepositoryGitPack?: (input: {
    temporaryRoot: string;
    signal: AbortSignal;
    retainedCommit?: string;
  }) => Promise<string>;
  requireCurrent: () => void;
  signal?: AbortSignal;
}): {
  project: ProjectPreparation;
  getPreparedWorkspace: () => PreparationResult["preparedWorkspace"];
  close: () => void;
} {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Worker project preparation namespace is invalid");
  }
  const preparation = params.preparation;
  if (preparation?.setupRecipe && preparation.runSetupScript !== false && !params.setupAuthorized) {
    throw new Error("Prepared project setup requires operator.admin authorization");
  }
  const abort = new AbortController();
  // Stop must reach active Git/transport work, not only the next owner check.
  const signal = params.signal ? AbortSignal.any([abort.signal, params.signal]) : abort.signal;
  const label =
    "source" in params.project
      ? normalizeCloudRepo(params.project.source.url)
      : params.project.label;
  // One owner represents one fixed allocation; retries on another machine get a new owner.
  let active: Promise<PreparationResult> | undefined;
  let preparedWorkspace: PreparationResult["preparedWorkspace"];
  let mergedSetup: unknown;
  // The serialized pre-enrollment producer invalidates completion before mutation.
  // Reuse verification only within this operation; replay starts with a fresh scan.
  let verifiedRetained: PreparedProjectVerification | null | undefined;
  const phaseDurationsMs: Record<string, number> = {};
  const collectPhases = (value: unknown) => {
    for (const [phase, duration] of Object.entries(
      RecipePreparation.shape.phaseDurationsMs.parse(value) ?? {},
    )) {
      phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + duration;
    }
  };
  const readRecipePreparation = (value?: unknown) => {
    const recipe = RecipePreparation.parse(
      value ?? {
        source: preparation?.recipe?.source ?? (preparation?.setupRecipe ? "script" : "none"),
      },
    );
    collectPhases(recipe.phaseDurationsMs);
    return { ...recipe, phaseDurationsMs };
  };
  const requireCurrent = () => {
    signal.throwIfAborted();
    try {
      params.requireCurrent();
    } catch (error) {
      abort.abort(error);
      throw error;
    }
  };
  const readPreparedWorkspace = (prepared: unknown, baseCommit: string) => {
    if (!preparation) {
      throw new Error("Project preparation did not request a prepared workspace");
    }
    const suffix = `/.openclaw-worker/prepared/${params.namespace}/${preparation.cacheKey}`;
    if (
      !isRecord(prepared) ||
      typeof prepared.workspaceDir !== "string" ||
      prepared.workspaceDir.length > 4096 ||
      !path.posix.isAbsolute(prepared.workspaceDir) ||
      path.posix.normalize(prepared.workspaceDir) !== prepared.workspaceDir ||
      !prepared.workspaceDir.endsWith(`${suffix}/workspace`) ||
      prepared.homeDir !== path.posix.join(path.posix.dirname(prepared.workspaceDir), "home") ||
      typeof prepared.sourceManifestRef !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(prepared.sourceManifestRef) ||
      typeof prepared.preparedManifestRef !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(prepared.preparedManifestRef)
    ) {
      throw new Error("Prepared project returned invalid workspace identity");
    }
    return Object.freeze({
      preparationKey: preparation.key,
      baseCommit,
      cacheKey: preparation.cacheKey,
      workspaceDir: prepared.workspaceDir,
      homeDir: prepared.homeDir,
      sourceManifestRef: prepared.sourceManifestRef,
      preparedManifestRef: prepared.preparedManifestRef,
    });
  };
  const preparationInput = preparation && {
    preparationKey: preparation.key,
    cacheKey: preparation.cacheKey,
    setupRecipe: preparation.setupRecipe,
    runSetupScript: preparation.runSetupScript,
    recipe: preparation.recipe,
  };
  const sourceInput = {
    namespace: params.namespace,
    seedKey: workerProjectSeedKey(params.project),
    baseCommit: params.project.baseCommit,
  };
  const prepareSeed: ProjectPreparation["prepare"] = async (transport) => {
    const { seedKey } = sourceInput;
    const scriptInput = {
      ...sourceInput,
      projectKey: params.project.key,
      ...(preparationInput ? { preparation: preparationInput } : {}),
    };
    requireCurrent();
    const runSeed = async (
      input: Parameters<typeof createProjectSeedScript>[0],
    ): Promise<unknown> => {
      requireCurrent();
      return JSON.parse(
        await (preparationInput && (input.pack || input.repository)
          ? transport.runScriptWithBudget!(
              (timeoutMs, setupEnv) =>
                createProjectSeedScript({
                  ...input,
                  preparation: { ...preparationInput, timeoutMs, setupEnv },
                }),
              signal,
            )
          : transport.runScript(createProjectSeedScript(input), signal)),
      );
    };
    const publicRepository =
      "source" in params.project && !params.prepareRepositoryGitPack
        ? { url: params.project.source.url }
        : undefined;
    const inspection = await runSeed({
      ...scriptInput,
      ...(publicRepository ? { repository: publicRepository } : {}),
    });
    requireCurrent();
    if (!isRecord(inspection) || typeof inspection.ready !== "boolean") {
      throw new Error("Project preparation returned invalid seed status");
    }
    collectPhases(inspection.phaseDurationsMs);
    if (preparation) {
      const retained = inspection.retainedWorkspace;
      if (retained === null) {
        verifiedRetained = null;
      } else {
        if (
          !isRecord(retained) ||
          typeof retained.baseCommit !== "string" ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(retained.baseCommit) ||
          retained.baseCommit.length !== params.project.baseCommit.length
        ) {
          throw new Error("Project preparation returned an invalid retained Git base");
        }
        const workspace = readPreparedWorkspace(retained);
        verifiedRetained = {
          baseCommit: retained.baseCommit,
          sourceManifestRef: workspace.sourceManifestRef,
          preparedManifestRef: workspace.preparedManifestRef,
        };
      }
    }
    if (
      params.snapshotStart &&
      transport.snapshotBaseCommit &&
      (!inspection.ready ||
        !inspection.preparedWorkspace ||
        verifiedRetained?.baseCommit !== sourceInput.baseCommit)
    ) {
      throw new Error("Selected snapshot has no matching completed repository workspace");
    }
    if (inspection.ready) {
      mergedSetup = inspection.preparedWorkspace;
      return {
        seedKey,
        cacheHit: inspection.cacheHit !== false,
        recipePreparation: readRecipePreparation(),
      };
    }
    const directory = inspection.directory;
    const retainedCommit = verifiedRetained?.baseCommit;
    if (
      typeof directory !== "string" ||
      directory.length > 4096 ||
      !path.posix.isAbsolute(directory) ||
      !directory.includes(`/.openclaw-worker/git-seeds/${params.namespace}/`) ||
      path.posix.normalize(directory) !== directory ||
      path.posix.basename(path.posix.dirname(directory)) !== params.namespace ||
      !path.posix.basename(directory).startsWith(`.tmp-${seedKey}-`)
    ) {
      throw new Error("Project preparation returned an invalid staging directory");
    }
    const temporaryRoot = await fsp.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-project-base-"),
    );
    try {
      requireCurrent();
      const repository = "source" in params.project ? params.project.source : undefined;
      const pack =
        "root" in params.project
          ? await prepareWorkerWorkspaceGitPack({
              root: params.project.root,
              baseCommit: params.project.baseCommit,
              ...(typeof retainedCommit === "string" ? { retainedCommit } : {}),
              temporaryRoot,
              signal,
            })
          : await params.prepareRepositoryGitPack!({ temporaryRoot, signal, retainedCommit });
      requireCurrent();
      const bytes = (await fsp.stat(pack)).size;
      if (bytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
        throw new Error("Project Git pack exceeds the workspace byte limit");
      }
      let sha256: string;
      {
        await using handle = await fsp.open(pack, "r");
        ({ digest: sha256 } = await sha256File(handle, { signal }));
      }
      requireCurrent();
      await transport.upload(pack, path.posix.join(directory, "base.pack"), signal);
      requireCurrent();
      const packInput = {
        directory,
        bytes,
        sha256,
        ...(repository ? { repositoryUrl: repository.url } : {}),
        ...(retainedCommit ? { retainedCommit } : {}),
      };
      const installed = await runSeed({
        ...scriptInput,
        pack: packInput,
        verifiedRetained,
      });
      requireCurrent();
      if (!isRecord(installed) || installed.ready !== true) {
        throw new Error("Project checkout was not verified before capture");
      }
      collectPhases(installed.phaseDurationsMs);
      mergedSetup = installed.preparedWorkspace;
      return { seedKey, cacheHit: false, recipePreparation: readRecipePreparation() };
    } finally {
      await fsp.rm(temporaryRoot, { recursive: true, force: true });
    }
  };
  const prepare: ProjectPreparation["prepare"] = async (transport) => {
    requireCurrent();
    if ("source" in params.project) {
      if (!params.revalidateRepositorySource) {
        throw new Error("Repository project preparation has no current source authority");
      }
      // Retained content does not establish current repository visibility or access.
      await params.revalidateRepositorySource(signal);
      requireCurrent();
    }
    if (preparationInput && !transport.runScriptWithBudget) {
      throw new Error("Prepared workspaces require a provider command budget");
    }
    if (params.snapshotStart && preparationInput && transport.snapshotBaseCommit) {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(transport.snapshotBaseCommit)) {
        throw new Error("Selected snapshot has an invalid repository base");
      }
      // Activation fetches refs without changing this checkout; publication owns integration.
      sourceInput.baseCommit = transport.snapshotBaseCommit;
      sourceInput.seedKey = workerProjectSeedKey({
        ...params.project,
        baseCommit: sourceInput.baseCommit,
      });
    }
    const result = await prepareSeed(transport);
    requireCurrent();
    if (!preparationInput) {
      await transport.recordRecipePreparation?.(result.recipePreparation!);
      requireCurrent();
      return result;
    }
    // Seed transfer can outlive its caller. Repository code starts only under
    // the current provisioning owner, and never runs in a later session's HOME.
    const prepared: unknown =
      mergedSetup ??
      JSON.parse(
        await transport.runScriptWithBudget!(
          (timeoutMs, setupEnv) =>
            createProjectSetupScript({
              ...sourceInput,
              ...preparationInput,
              timeoutMs,
              setupEnv,
              verifiedRetained,
            }),
          signal,
        ),
      );
    requireCurrent();
    if (!isRecord(prepared)) {
      throw new Error("Prepared project returned invalid setup status");
    }
    const recipePreparation = mergedSetup
      ? { ...RecipePreparation.parse(prepared.recipePreparation), phaseDurationsMs }
      : readRecipePreparation(prepared.recipePreparation);
    await transport.recordRecipePreparation?.(recipePreparation);
    requireCurrent();
    if (typeof prepared.setupFailure === "string") {
      throw new Error(
        `${prepared.setupFailure}${recipePreparation.failure?.outputTail ? `: ${recipePreparation.failure.outputTail}` : ""}`,
      );
    }
    preparedWorkspace = readPreparedWorkspace(prepared, sourceInput.baseCommit);
    return {
      ...result,
      baseCommit: sourceInput.baseCommit,
      preparedWorkspace,
      recipePreparation,
      ...(typeof prepared.captureSkipped === "string"
        ? { captureSkipped: prepared.captureSkipped }
        : result.cacheHit && verifiedRetained?.baseCommit === sourceInput.baseCommit
          ? {}
          : { captureRequired: true as const }),
    };
  };
  return {
    getPreparedWorkspace: () => preparedWorkspace,
    project: {
      key: params.project.key,
      baseCommit: params.project.baseCommit,
      ...(preparation?.recipe?.secretNames ? { secretNames: preparation.recipe.secretNames } : {}),
      ...("source" in params.project ? {} : { root: params.project.root }),
      ...(label !== undefined ? { label } : {}),
      ...(preparation && preparationInput
        ? {
            preparation: {
              key: preparation.key,
              cacheKey: preparation.cacheKey,
              purpose: preparation.purpose,
              demandAtMs: preparation.demandAtMs,
            },
            inspectPreparedWorkspace: async (transport: {
              baseCommit?: string;
              runScript: (script: string, signal: AbortSignal) => Promise<string>;
              recordRecipePreparation?: (value: WorkerRecipePreparation) => Promise<void>;
            }) => {
              requireCurrent();
              const inspected: unknown = JSON.parse(
                await transport.runScript(
                  createProjectSetupScript({ ...sourceInput, ...preparationInput }, true),
                  signal,
                ),
              );
              requireCurrent();
              if (
                !isRecord(inspected) ||
                inspected.baseCommit !== (transport.baseCommit ?? sourceInput.baseCommit)
              ) {
                throw new Error("Enrolled project has no matching completed workspace");
              }
              preparedWorkspace = readPreparedWorkspace(
                inspected,
                transport.baseCommit ?? sourceInput.baseCommit,
              );
              await transport.recordRecipePreparation?.(
                readRecipePreparation(inspected.recipePreparation),
              );
              requireCurrent();
            },
          }
        : {}),
      signal,
      assertCurrent: requireCurrent,
      prepare: (transport) => {
        requireCurrent();
        return (active ??= prepare(transport));
      },
    },
    close: () =>
      abort.abort(new DOMException("Project preparation operation is closed", "AbortError")),
  };
}

export function projectReplayIdentity(project: unknown): unknown {
  if (!isRecord(project)) {
    return project;
  }
  // Display metadata can change without changing the admitted preparation.
  const identity = { ...project };
  delete identity.label;
  // Local keys bind shared Git storage; a checkout path is only its transport location.
  if (!Object.hasOwn(identity, "source")) {
    delete identity.root;
  }
  return identity;
}
