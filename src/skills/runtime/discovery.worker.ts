import { sha256Hex } from "../../infra/crypto-digest.js";
import { isPathInside } from "../../infra/path-guards.js";
import { applyProcessEnvKeys } from "../../infra/process-env.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  createPluginCache,
  withPluginCache,
  type PluginCache,
} from "../../plugins/plugin-cache.js";
import { pinConfigDir } from "../../utils.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromContributions,
} from "../loading/plugin-skills.js";
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
import type {
  SkillsDiscoveryInput,
  SkillsDiscoveryOutput,
  SkillsDiscoveryEnvironment,
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

serveWorkerTasks<SkillsDiscoveryOutput>((input, channel) => {
  // SAFETY: This private worker only receives the discovery owner's typed requests.
  const request = input as SkillsDiscoveryInput;
  channel?.consumeInput();
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
    return {
      kind: "project",
      snapshot,
      resolvedIndices: resolvedSkills!.map((skill) => indices.get(skill)!),
      discoveryIndices: discoverySkills!.map((skill) => indices.get(skill)!),
    };
  }
  if (request.kind === "status") {
    applyEnvironment(request.environment);
    return { kind: "status", facts: readWorkspaceSkillStatusFacts(request.input) };
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
  return {
    kind: "scan",
    results: request.requests.map(({ key, environment, selection }) => {
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
      const sources = readWorkspaceSkillSources(sourceRequest, batch);
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
      return {
        key,
        sources,
        watchDirectories: [...watchDirectories],
        plan: selection.plan ? resolvedPlan : undefined,
        fingerprint: sha256Hex(JSON.stringify([entries, sources.runtime])),
      };
    }),
  };
});
