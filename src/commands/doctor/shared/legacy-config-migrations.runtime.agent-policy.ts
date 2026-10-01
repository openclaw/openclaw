import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { mergeMissing } from "../../../config/merge-missing.js";
import { someAgentEntry, visitAgentConfigScopes } from "./legacy-config-record-shared.js";
import {
  modelEntryWithRuntimePolicy,
  selectedCanonicalModelRefsForRuntimePolicy,
} from "./legacy-runtime-model-policy.js";
import { resolveLegacyCliRuntimeAlias } from "./legacy-runtime-model-providers.js";

const LEGACY_AGENT_RUNTIME_POLICY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "embeddedHarness"],
    message:
      'agents.defaults.embeddedHarness is ignored; use provider/model runtime policy. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents"],
    message:
      'Agent embeddedHarness settings are ignored; use provider/model runtime policy. Run "openclaw doctor --fix".',
    match: (value) => someAgentEntry(value, (agent) => getRecord(agent.embeddedHarness) !== null),
  },
  {
    path: ["agents", "defaults", "agentRuntime", "fallback"],
    message:
      'agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "defaults", "agentRuntime"],
    message:
      'agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run "openclaw doctor --fix".',
    match: (value) => someAgentEntry(value, (agent) => getRecord(agent.agentRuntime) !== null),
  },
];

function removeLegacyAgentRuntimePolicy(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (getRecord(container.embeddedHarness) !== null) {
    delete container.embeddedHarness;
    changes.push(`Removed ${pathLabel}.embeddedHarness; runtime is now provider/model scoped.`);
  }
  if (getRecord(container.agentRuntime) !== null) {
    preserveLegacyWholeAgentRuntimePolicy(container, pathLabel, changes);
    delete container.agentRuntime;
    changes.push(`Removed ${pathLabel}.agentRuntime; runtime is now provider/model scoped.`);
  }
}

function preserveLegacyWholeAgentRuntimePolicy(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  const intent = resolveLegacyCliRuntimeAlias(getRecord(container.agentRuntime)?.id);
  if (!intent) {
    return;
  }
  const selectedRefs = selectedCanonicalModelRefsForRuntimePolicy(container.model, intent.provider);
  if (selectedRefs.length === 0) {
    return;
  }

  const currentModels = getRecord(container.models);
  const nextModels: Record<string, unknown> = currentModels ? { ...currentModels } : {};
  let changed = false;
  for (const ref of selectedRefs) {
    const updated = modelEntryWithRuntimePolicy(nextModels[ref], intent.runtime);
    if (!updated.changed) {
      continue;
    }
    nextModels[ref] = updated.entry;
    changed = true;
  }
  if (!changed) {
    return;
  }
  container.models = nextModels;
  changes.push(
    `Moved ${pathLabel}.agentRuntime.id ${intent.runtime} to matching ${intent.provider} model runtime policy.`,
  );
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENT_POLICY: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.embeddedPi->embeddedAgent",
    describe: "Move supported legacy embedded agent settings to embeddedAgent",
    legacyRules: [
      {
        path: ["agents"],
        message: 'Agent embeddedPi settings moved to embeddedAgent. Run "openclaw doctor --fix".',
        match: (value) => {
          let found = false;
          visitAgentConfigScopes({ agents: value }, (agent) => {
            found ||= getRecord(agent.embeddedPi) !== null;
          });
          return found;
        },
      },
    ],
    apply: (raw, changes) =>
      visitAgentConfigScopes(raw, (agent, path) => {
        const legacy = getRecord(agent.embeddedPi);
        if (!legacy) {
          return;
        }
        const existing = getRecord(agent.embeddedAgent);
        const target = structuredClone(existing ?? {});
        mergeMissing(target, legacy);
        agent.embeddedAgent = target;
        delete agent.embeddedPi;
        changes.push(
          existing
            ? `Merged ${path}.embeddedPi → ${path}.embeddedAgent (kept explicit embeddedAgent values).`
            : `Moved ${path}.embeddedPi → ${path}.embeddedAgent.`,
        );
      }),
  }),
  defineLegacyConfigMigration({
    id: "agents.agentRuntime-ignored",
    describe: "Remove ignored agent-wide runtime policy",
    legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
    apply: (raw, changes) =>
      visitAgentConfigScopes(raw, (agent, path) =>
        removeLegacyAgentRuntimePolicy(agent, path, changes),
      ),
  }),
];
