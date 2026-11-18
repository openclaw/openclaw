import path from "node:path";
import { readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as createRoot } from "@openclaw/fs-safe/root";
import type { WorkerTaskHandler } from "@openclaw/worker-runtime/worker";
import {
  resolveSandboxFsPreparation,
  resolveSandboxFsPathWithMounts,
} from "../../agents/sandbox/fs-paths.js";
import { assertSandboxStateOwnerPathCurrent } from "../../agents/sandbox/state-owner-path.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { isPathInside } from "../../infra/path-guards.js";
import { applyProcessEnvKeys } from "../../infra/process-env.js";
import { withWorkerFsSafeNativeMode } from "../../infra/worker-fs-safe.js";
import { workerMutationAssertion } from "../../infra/worker-mutation-authority.js";
import { encodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  createPluginCache,
  withPluginCache,
  type PluginCache,
} from "../../plugins/plugin-cache.js";
import { pinConfigDir } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromContributions,
} from "../loading/plugin-skills.js";
import type { Skill } from "../loading/skill-contract.js";
import {
  appendLowerPrecedenceSkillRecords,
  mergeSkillRecords,
} from "../loading/skill-precedence.js";
import type { SkillSourceReadBatch } from "../loading/skill-root-loader.js";
import { buildSkillSnapshotProjection } from "../loading/skill-snapshot-projection.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import { resolveWorkspaceSkillDirectories } from "../loading/workspace-skill-roots.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
} from "../loading/workspace-skill-sources.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import type {
  SkillsDiscoveryInput,
  SkillsDiscoveryOutput,
  SkillsDiscoveryEnvironment,
  SkillsDiscoveryResult,
  SkillsSourcePlanInput,
} from "./discovery-worker-contract.js";

function applyEnvironment(environment: SkillsDiscoveryEnvironment) {
  applyProcessEnvKeys(Object.keys(environment), environment);
  pinConfigDir();
}

function resolveInputPlan(input: SkillsSourcePlanInput, cache: PluginCache = createPluginCache()) {
  return withPluginCache(cache, () => {
    const options = input.options;
    const pluginSkillRoots = options?.workspaceOnly
      ? []
      : input.pluginContributions
        ? resolvePluginSkillRootsFromContributions({
            contributions: input.pluginContributions,
            pluginSkillsDir: options?.pluginSkillsDir,
          })
        : resolvePluginSkillRoots({
            workspaceDir: input.workspaceDir,
            config: options?.config,
            pluginSkillsDir: options?.pluginSkillsDir,
            acpRuntimeAvailable: input.acpRuntimeAvailable,
          });
    return resolveWorkspaceSkillSourcePlan(input.workspaceDir, {
      ...options,
      pluginSkillRoots,
      ...(input.agentSkillsDirs ? { agentSkillsDirs: input.agentSkillsDirs } : {}),
    });
  });
}

async function prepareResourceRootIdentity(skill: Skill): Promise<Skill["resourceRootIdentity"]> {
  if (
    skill.disableModelInvocation ||
    resolveSkillFileHost(skill) === "workspace" ||
    !path.isAbsolute(skill.filePath)
  ) {
    return undefined;
  }
  if (skill.resourceRootIdentity) {
    return skill.resourceRootIdentity;
  }
  try {
    // Follow the permitted root link; descendants remain confined by Root.read.
    const identity = await readDirectoryIdentity(`${path.dirname(skill.filePath)}${path.sep}.`);
    return {
      realPath: identity.realPath,
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const runTask: WorkerTaskHandler<SkillsDiscoveryOutput, SkillsDiscoveryInput> = (
  request,
  channel,
  control,
) => {
  channel?.consumeInput();
  if (request.kind === "companion") {
    return (async () => {
      const resource = await createRoot(request.directoryPath);
      const admitted = await resource.stat(".");
      if (
        resource.rootReal !== request.identity.realPath ||
        admitted.exactIdentity?.dev.toString() !== request.identity.dev ||
        admitted.exactIdentity.ino.toString() !== request.identity.ino
      ) {
        throw new Error("Skill resource directory changed after preparation");
      }
      // This same Root rejects replacement between its identity check and the read.
      const { buffer } = await resource.read(request.relativePath, {
        maxBytes: request.maxBytes,
        symlinks: "reject",
        hardlinks: "reject",
      });
      return { kind: "companion" as const, buffer };
    })();
  }
  if (request.kind === "sandbox-path") {
    control.throwIfCancelled();
    return { kind: "sandbox-path", path: resolveSandboxFsPathWithMounts(request.input) };
  }
  if (request.kind === "sandbox-projection") {
    return { kind: "sandbox-projection", preparation: resolveSandboxFsPreparation(request.input) };
  }
  if (request.kind === "sandbox-mounts" || request.kind === "sandbox-mount-sources") {
    if (request.authority && !channel) {
      throw new Error("Sandbox mount preparation requires its live host channel");
    }
    return control.runNativeSection<SkillsDiscoveryOutput>(async () => {
      const assertHost = request.authority
        ? workerMutationAssertion(
            request.authority,
            () => channel?.notify("authority"),
            control.throwIfCancelled,
          )
        : control.throwIfCancelled;
      const assertCurrent = () => {
        control.throwIfCancelled();
        if (request.stateOwnerPath) {
          assertSandboxStateOwnerPathCurrent(request.stateOwnerPath);
        }
        assertHost();
      };
      try {
        if (request.kind === "sandbox-mount-sources") {
          const { ensureReadOnlyWorkspaceSkillMountSources } =
            await import("../../agents/sandbox/workspace-mounts.js");
          return {
            kind: "sandbox-mount-sources",
            created: await ensureReadOnlyWorkspaceSkillMountSources(request.input, assertCurrent),
          };
        }
        const { prepareSandboxMountPlanFilesystem } =
          await import("../../agents/sandbox/mount-plan.prepare.js");
        return {
          kind: "sandbox-mounts",
          plan: await prepareSandboxMountPlanFilesystem(request.input, assertCurrent),
        };
      } catch (error) {
        return { kind: "sandbox-mounts-error", error: encodeNativeWorkerFailure(error) };
      }
    });
  }
  if (request.kind === "library") {
    return import("../library/filesystem.kernel.js").then(
      async ({ executeSkillLibraryFilesystemTask }) => ({
        kind: "library" as const,
        result: await executeSkillLibraryFilesystemTask(request.input),
      }),
    );
  }
  if (request.kind === "sync-filesystem") {
    if (request.authority && !channel) {
      throw new Error("Skills synchronization requires its live host channel");
    }
    return control.runNativeSection<SkillsDiscoveryOutput>(async () => {
      const assertHost = request.authority
        ? workerMutationAssertion(
            request.authority,
            () => channel?.notify("authority"),
            control.throwIfCancelled,
          )
        : control.throwIfCancelled;
      const assertCurrent = () => {
        control.throwIfCancelled();
        if (request.stateOwnerPath) {
          assertSandboxStateOwnerPathCurrent(request.stateOwnerPath);
        }
        assertHost();
      };
      try {
        const { runSkillsSyncFilesystem } =
          await import("../loading/workspace-skill-sync-files.js");
        return {
          kind: "sync-filesystem",
          prepared: await runSkillsSyncFilesystem(request.operation, assertCurrent, (phase) =>
            channel?.notify(phase),
          ),
        };
      } catch (error) {
        return {
          kind: "sync-filesystem-error",
          error: encodeNativeWorkerFailure(error),
          code: error instanceof FsSafeError ? error.code : undefined,
          details: error instanceof FsSafeError ? error.details : undefined,
        };
      }
    });
  }
  if (request.kind === "plan") {
    applyEnvironment(request.input.environment);
    return { kind: "plan", plan: resolveInputPlan(request.input) };
  }
  if (request.kind === "project") {
    applyEnvironment(request.environment);
    const { resolvedSkills, discoverySkills, ...snapshot } = buildSkillSnapshotProjection(
      request.input,
    );
    // Return selection, not another resident copy of the caller's parsed catalog.
    const indices = new Map(request.input.eligible.map((entry, index) => [entry.skill, index]));
    const discoverable = new Set(discoverySkills);
    return Promise.all(
      request.input.eligible.map(async ({ skill }) =>
        discoverable.has(skill) ? prepareResourceRootIdentity(skill) : undefined,
      ),
    ).then((resourceRoots) => ({
      kind: "project" as const,
      snapshot,
      resolvedIndices: resolvedSkills!.map((skill) => indices.get(skill)!),
      discoveryIndices: discoverySkills!.map((skill) => indices.get(skill)!),
      resourceRoots,
    }));
  }
  if (request.kind === "status") {
    applyEnvironment(request.environment);
    return (async () => {
      const { readWorkspaceSkillStatusFacts } = await import("../discovery/status-files.js");
      return { kind: "status" as const, facts: readWorkspaceSkillStatusFacts(request.input) };
    })();
  }
  if (request.path === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = request.path;
  }
  // Share physical inventory facts across workspaces, then discard them for the next pass.
  const pluginCache = createPluginCache();
  const sourceReads = new Map<string, SkillSourceReadBatch>();
  const plans = new Map<string, ReturnType<typeof resolveInputPlan>>();
  const selectPlan = (sourceInput: SkillsSourcePlanInput) => {
    const key = JSON.stringify(sourceInput);
    const plan = plans.get(key) ?? resolveInputPlan(sourceInput, pluginCache);
    plans.set(key, plan);
    return plan;
  };
  return (async () => {
    const results: SkillsDiscoveryResult[] = [];
    // Each read must finish before the next workspace replaces process.env.
    for (const { key, environment, selection } of request.requests) {
      applyEnvironment(environment);
      const resolvedPlan =
        selection.kind === "planned"
          ? selectPlan(selection.plan.input)
          : selection.plan
            ? selectPlan(selection.plan.input)
            : selection.request.sourcePlan;
      const sourceRequest = {
        ...selection.request,
        sourcePlan:
          selection.kind === "selected" && selection.plan?.scope === "gateway"
            ? splitSkillSourcePlan(resolvedPlan).gatewayPlan
            : resolvedPlan,
      };
      const environmentKey = JSON.stringify(environment);
      let batch = sourceReads.get(environmentKey);
      if (!batch) {
        batch = new Map();
        sourceReads.set(environmentKey, batch);
      }
      const sources = await readWorkspaceSkillSources(sourceRequest, batch);
      await Promise.all(
        [...sources.entries, ...sources.executionEntries].map(async ({ skill }) => {
          skill.resourceRootIdentity = await prepareResourceRootIdentity(skill);
        }),
      );
      // Fingerprints need precedence winners, not collision diagnostics.
      const entries = mergeSkillRecords(sources.entries, key, false);
      appendLowerPrecedenceSkillRecords(
        entries,
        mergeSkillRecords(sources.executionEntries, key, false),
        () => {},
      );
      // Generated plugin links are shared outputs; watch their canonical sources instead.
      const watchDirectories = new Set([
        ...sourceRequest.sourcePlan.roots.map((root) => root.dir),
        ...(sourceRequest.executionWorkspaceDir
          ? resolveWorkspaceSkillDirectories(sourceRequest.executionWorkspaceDir).map(
              (root) => root.dir,
            )
          : []),
      ]);
      const physicalRoots = [...watchDirectories].map((directory) => tryRealpath(directory));
      // Workspace entries retain configured paths; watch their admitted physical targets.
      for (const { skill } of [...sources.entries, ...sources.executionEntries]) {
        const target = tryRealpath(skill.baseDir);
        if (
          target &&
          !physicalRoots.some((directory) => directory && isPathInside(directory, target))
        ) {
          watchDirectories.add(target);
        }
      }
      results.push({
        key,
        sources,
        watchDirectories: [...watchDirectories],
        plan: selection.plan ? resolvedPlan : undefined,
        fingerprint: sha256Hex(JSON.stringify([entries, sources.runtime])),
      });
    }
    return { kind: "scan" as const, results };
  })();
};

serveWorkerTasks<SkillsDiscoveryOutput, SkillsDiscoveryInput>((request, channel, control) =>
  "nativeMode" in request
    ? withWorkerFsSafeNativeMode(request.nativeMode, () => runTask(request, channel, control))
    : runTask(request, channel, control),
);
