import { sha256Hex } from "../../infra/crypto-digest.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
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
import { buildSkillSnapshotProjection } from "../loading/skill-snapshot-projection.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-loader.js";
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
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  pinConfigDir();
}

function resolveInputPlan(input: SkillsSourcePlanInput) {
  // Each pass observes new/replaced plugin roots instead of reusing old filesystem facts.
  return withPluginCache(createPluginCache(), () => {
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
    return { kind: "project", snapshot: buildSkillSnapshotProjection(request.input) };
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
  const plans = new Map<string, ReturnType<typeof resolveInputPlan>>();
  return {
    kind: "scan",
    results: request.requests.map(({ key, request: sourceRequest, environment, plan }) => {
      applyEnvironment(environment);
      let resolvedPlan = sourceRequest.sourcePlan;
      if (plan) {
        const planKey = JSON.stringify(plan.input);
        resolvedPlan = plans.get(planKey) ?? resolveInputPlan(plan.input);
        plans.set(planKey, resolvedPlan);
      }
      sourceRequest.sourcePlan =
        plan?.scope === "gateway" ? splitSkillSourcePlan(resolvedPlan).gatewayPlan : resolvedPlan;
      const sources = readWorkspaceSkillSources(sourceRequest);
      const entries = mergeSkillRecords(sources.entries, key, []);
      appendLowerPrecedenceSkillRecords(
        entries,
        mergeSkillRecords(sources.executionEntries, key, []),
        () => {},
      );
      return {
        key,
        sources,
        plan: plan ? resolvedPlan : undefined,
        fingerprint: sha256Hex(JSON.stringify([entries, sources.runtime])),
      };
    }),
  };
});
