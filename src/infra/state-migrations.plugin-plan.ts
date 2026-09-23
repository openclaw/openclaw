import type { PluginDoctorStateMigrationInventory } from "../plugins/doctor-contract-registry.js";
import type { PreparedLegacyStateMigrationStep } from "./state-migrations.plan.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  PreparedPostSessionPluginMigration,
} from "./state-migrations.types.js";

type PlannedPluginStateMigrationDescriptor = {
  actions: PluginDoctorStateMigrationInventory["descriptors"];
  source: LegacyStateMigrationEndpoint[];
  target: LegacyStateMigrationEndpoint[];
  requiredness: PreparedLegacyStateMigrationStep["requiredness"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
};

export function buildPlannedPluginStateMigrationDescriptor(params: {
  inventory: PluginDoctorStateMigrationInventory;
  mode: LegacyStateMigrationMode;
  phase?: "after-session-repair";
}): PlannedPluginStateMigrationDescriptor {
  const actions = params.inventory.descriptors.filter(
    (descriptor) =>
      descriptor.phase === params.phase &&
      (params.mode === "doctor" || descriptor.doctorOnly !== true),
  );
  const unresolvedPluginIds = params.inventory.unresolvedPluginIds;
  const source = [
    ...actions.map((descriptor) => ({
      kind: "owner" as const,
      id: `plugin:${descriptor.pluginId}:${descriptor.id}`,
    })),
    ...unresolvedPluginIds.map((pluginId) => ({
      kind: "owner" as const,
      id: `plugin:${pluginId}:state-migrations`,
    })),
  ];
  const target = [
    ...new Set([...actions.map((descriptor) => descriptor.pluginId), ...unresolvedPluginIds]),
  ].map((pluginId) => ({
    kind: "owner" as const,
    id: `plugin:${pluginId}:doctor-state`,
  }));
  return {
    actions,
    source,
    target,
    requiredness:
      source.length > 0 || params.inventory.resolutionFailure ? "conditional" : "not-required",
    ...(params.inventory.resolutionFailure
      ? { refusal: params.inventory.resolutionFailure }
      : unresolvedPluginIds.length > 0
        ? {
            refusal: {
              code: "plugin-planning-deferred",
              message: `Plugin migration identities are not declared for: ${unresolvedPluginIds.join(", ")}.`,
            },
          }
        : {}),
  };
}

/** Freeze one deferred writer's authority from the selected plugin generation. */
export function preparePostSessionPluginMigration(params: {
  inventory: PluginDoctorStateMigrationInventory;
  mode: LegacyStateMigrationMode;
}): PreparedPostSessionPluginMigration {
  const { actions, ...descriptor } = buildPlannedPluginStateMigrationDescriptor({
    ...params,
    phase: "after-session-repair",
  });
  return {
    step: {
      id: "plugin-doctor-post-session-state",
      phase: "final",
      reversibility: "checkpoint-required",
      ...descriptor,
    },
    plannedActions: actions.map(({ pluginId, id }) => ({ pluginId, id })),
  };
}
