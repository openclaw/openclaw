import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  createActivationReadinessResolver,
  listActivationReadinessSubjects,
} from "./activation.js";
import {
  WORKSPACE_WRITABLE_CRITERION_ID,
  type ReadinessCondition,
  type ReadinessContribution,
  type ReadinessRequirement,
} from "./conditions.js";
import {
  createExecutionCapabilityReadinessResolver,
  listExecutionCapabilityReadinessSubjects,
  type ExecutionCapabilityReadinessSnapshot,
} from "./execution-capabilities.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";
import {
  buildSessionStorageReadinessCondition,
  createSessionStorageReadinessEvidenceResolver,
  listSessionStorageReadinessSubjects,
  SESSION_STORAGE_READY_CRITERION_ID,
} from "./session-storage.js";
import {
  createStateServiceReadinessResolver,
  listStateServiceReadinessSubjects,
  type StateServiceReadinessSnapshot,
} from "./state-services.js";
import {
  CORE_READINESS_SUBJECT_REFS,
  MAX_READINESS_SUBJECTS,
  type ReadinessSubject,
} from "./subjects.js";
import {
  buildWorkspaceReadinessCondition,
  createWorkspaceReadinessEvidenceResolver,
} from "./workspace.js";

type SelectedCriterion = {
  id: string;
  requirement: ReadinessRequirement;
};

const EVENT_LOOP_HEALTHY_CRITERION_ID = "openclaw.event-loop-healthy";
const PLUGINS_LOADED_CRITERION_ID = "openclaw.plugins-loaded";
const BASE_RUNTIME_SUBJECT_REFS = [
  CORE_READINESS_SUBJECT_REFS.hostInstance,
  CORE_READINESS_SUBJECT_REFS.process,
  CORE_READINESS_SUBJECT_REFS.gateway,
  CORE_READINESS_SUBJECT_REFS.config,
  CORE_READINESS_SUBJECT_REFS.plugins,
] as const;

const CANONICAL_CONDITION_TYPES = new Map<string, ReadinessCondition["type"]>([
  [EVENT_LOOP_HEALTHY_CRITERION_ID, "EventLoopHealthy"],
  [PLUGINS_LOADED_CRITERION_ID, "PluginsLoaded"],
]);

function resolveSelectedReadinessCriteria(config: OpenClawConfig): SelectedCriterion[] {
  const required = config.gateway?.readiness?.requiredCriteria ?? [];
  const advisory = config.gateway?.readiness?.advisoryCriteria ?? [];
  const selected = new Map<string, ReadinessRequirement>();
  for (const id of advisory) {
    selected.set(id, "advisory");
  }
  for (const id of required) {
    selected.set(id, "required");
  }
  return Array.from(selected, ([id, requirement]) => ({ id, requirement }));
}

export function applySelectedCanonicalRequirements(
  config: OpenClawConfig,
  conditions: readonly ReadinessCondition[],
): ReadinessCondition[] {
  const selected = resolveSelectedReadinessCriteria(config);
  const requirementsByType = new Map<ReadinessCondition["type"], ReadinessRequirement>();
  for (const { id, requirement } of selected) {
    const type = CANONICAL_CONDITION_TYPES.get(id);
    if (type !== undefined) {
      requirementsByType.set(type, requirement);
    }
  }
  const projected = conditions.map((condition) => {
    const requirement = requirementsByType.get(condition.type);
    return requirement === undefined ? condition : { ...condition, requirement };
  });
  const presentTypes = new Set(projected.map((condition) => condition.type));
  for (const [type, requirement] of requirementsByType) {
    if (presentTypes.has(type)) {
      continue;
    }
    projected.push({
      type,
      subjectRef:
        type === "PluginsLoaded"
          ? CORE_READINESS_SUBJECT_REFS.plugins
          : CORE_READINESS_SUBJECT_REFS.gateway,
      status: "Unknown",
      requirement,
      reason: "CriterionEvaluationUnavailable",
      message: `Readiness criterion ${type} was selected but could not be evaluated.`,
    });
  }
  return projected;
}

function unavailableCondition(id: string, requirement: ReadinessRequirement): ReadinessCondition {
  return {
    type: id,
    subjectRef: CORE_READINESS_SUBJECT_REFS.plugins,
    status: "Unknown",
    requirement,
    reason: "CriterionNotRegistered",
    message: `Readiness criterion ${id} is selected but is not registered.`,
  };
}

function withRequirement(
  condition: ReadinessCondition,
  requirement: ReadinessRequirement,
): ReadinessCondition {
  return {
    type: condition.type,
    subjectRef: condition.subjectRef,
    ...(condition.relatedSubjectRefs ? { relatedSubjectRefs: condition.relatedSubjectRefs } : {}),
    ...(condition.observedAtMs !== undefined ? { observedAtMs: condition.observedAtMs } : {}),
    status: condition.status,
    requirement,
    reason: condition.reason,
    message: condition.message,
  };
}

function enforceSelectedSubjectLimit(
  conditions: ReadinessCondition[],
  subjects: ReadinessSubject[],
): ReadinessContribution {
  const subjectsByRef = new Map(subjects.map((subject) => [subject.ref, subject]));
  const retainedRefs = new Set<string>(BASE_RUNTIME_SUBJECT_REFS);
  const projected = [...conditions];
  const collectRefs = (condition: ReadinessCondition) => {
    const refs = new Set<string>();
    const pending = [condition.subjectRef, ...(condition.relatedSubjectRefs ?? [])];
    while (pending.length > 0) {
      const ref = pending.pop();
      if (!ref || refs.has(ref)) {
        continue;
      }
      refs.add(ref);
      const subject = subjectsByRef.get(ref);
      if (!subject) {
        continue;
      }
      if (subject.parentRef) {
        pending.push(subject.parentRef);
      }
    }
    return refs;
  };
  const accept = (index: number) => {
    const condition = projected[index];
    if (!condition) {
      return;
    }
    const conditionRefs = collectRefs(condition);
    const additionalCount = [...conditionRefs].filter((ref) => !retainedRefs.has(ref)).length;
    if (
      condition.type.startsWith("plugin.") &&
      retainedRefs.size + additionalCount > MAX_READINESS_SUBJECTS
    ) {
      projected[index] = {
        type: condition.type,
        subjectRef: CORE_READINESS_SUBJECT_REFS.plugins,
        status: "Unknown",
        requirement: condition.requirement,
        reason: "CriterionSubjectLimitExceeded",
        message: `Readiness criterion ${condition.type} exceeded the aggregate subject limit.`,
      };
      return;
    }
    for (const ref of conditionRefs) {
      retainedRefs.add(ref);
    }
  };

  const pluginIndices: number[] = [];
  for (const [index, condition] of projected.entries()) {
    if (condition.type.startsWith("plugin.")) {
      pluginIndices.push(index);
    } else {
      accept(index);
    }
  }
  pluginIndices.sort((left, right) => {
    const leftRequired = projected[left]?.requirement === "required";
    const rightRequired = projected[right]?.requirement === "required";
    return Number(rightRequired) - Number(leftRequired) || left - right;
  });
  for (const index of pluginIndices) {
    accept(index);
  }

  return {
    conditions: projected,
    subjects: subjects.filter((subject) => retainedRefs.has(subject.ref)),
  };
}

function stateServiceSelectorId(condition: ReadinessCondition): string | undefined {
  switch (condition.type) {
    case "StateReady":
      return "openclaw.state-ready";
    case "DeliveryRuntimeReady":
      return "openclaw.delivery-runtime-ready";
    case "SchedulerReady":
      return "openclaw.scheduler-ready";
    default:
      return undefined;
  }
}

export function createSelectedReadinessResolver() {
  const resolveWorkspace = createWorkspaceReadinessEvidenceResolver();
  const resolveSessionStorage = createSessionStorageReadinessEvidenceResolver();
  const resolvePlugins = createPluginReadinessResolver();
  const resolveActivation = createActivationReadinessResolver();
  const resolveExecutionCapabilities = createExecutionCapabilityReadinessResolver();
  const resolveStateServices = createStateServiceReadinessResolver();

  return async (params: {
    config: OpenClawConfig;
    registry: Pick<PluginRegistry, "readinessCriteria">;
    executionCapabilities?: ExecutionCapabilityReadinessSnapshot;
    env?: NodeJS.ProcessEnv;
    stateServices?: StateServiceReadinessSnapshot;
  }): Promise<ReadinessContribution> => {
    const selected = resolveSelectedReadinessCriteria(params.config).filter(
      ({ id }) => !CANONICAL_CONDITION_TYPES.has(id),
    );
    if (selected.length === 0) {
      return { conditions: [], subjects: [] };
    }

    const selectedIds = new Set(selected.map((entry) => entry.id));
    const pluginIds = new Set(
      selected.filter((entry) => entry.id.startsWith("plugin.")).map((entry) => entry.id),
    );
    const [workspaceEvidence, sessionStorageEvidence, pluginContribution] = await Promise.all([
      selectedIds.has(WORKSPACE_WRITABLE_CRITERION_ID)
        ? resolveWorkspace({ config: params.config, env: params.env })
        : Promise.resolve(undefined),
      selectedIds.has(SESSION_STORAGE_READY_CRITERION_ID)
        ? resolveSessionStorage({ config: params.config, env: params.env })
        : Promise.resolve(undefined),
      resolvePlugins({ registry: params.registry, config: params.config, criterionIds: pluginIds }),
    ]);
    // Owner snapshots are synchronous and sampled last so no asynchronous provider work can
    // publish a replacement generation between activation observation and result assembly.
    const activationConditions = resolveActivation({
      config: params.config,
      criterionIds: selectedIds,
      env: params.env,
    });

    const conditions = new Map<string, ReadinessCondition>();
    for (const [id, condition] of activationConditions) {
      conditions.set(id, condition);
    }
    for (const [id, capabilityCondition] of resolveExecutionCapabilities({
      config: params.config,
      criterionIds: selectedIds,
      snapshot: params.executionCapabilities,
    })) {
      conditions.set(id, capabilityCondition);
    }
    for (const condition of resolveStateServices({
      criterionIds: selectedIds,
      env: params.env,
      snapshot: params.stateServices,
    })) {
      const selectedId = stateServiceSelectorId(condition);
      if (selectedId) {
        conditions.set(selectedId, condition);
      }
    }
    if (workspaceEvidence) {
      conditions.set(
        WORKSPACE_WRITABLE_CRITERION_ID,
        buildWorkspaceReadinessCondition(workspaceEvidence),
      );
    }
    if (sessionStorageEvidence) {
      conditions.set(
        SESSION_STORAGE_READY_CRITERION_ID,
        buildSessionStorageReadinessCondition(sessionStorageEvidence),
      );
    }
    for (const condition of pluginContribution.conditions) {
      conditions.set(condition.type, condition);
    }

    const selectedConditions = selected.map(({ id, requirement }) => {
      const condition = conditions.get(id);
      return condition
        ? withRequirement(condition, requirement)
        : unavailableCondition(id, requirement);
    });
    return enforceSelectedSubjectLimit(selectedConditions, [
      ...listActivationReadinessSubjects(),
      ...listExecutionCapabilityReadinessSubjects(),
      ...listStateServiceReadinessSubjects(),
      ...listSessionStorageReadinessSubjects(),
      ...pluginContribution.subjects,
    ]);
  };
}
