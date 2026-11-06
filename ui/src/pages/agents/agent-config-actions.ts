import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SkillStatusReport } from "../../api/types.ts";
import { resolveAgentSkillsFilter } from "../../lib/agents/display.ts";
import {
  currentConfigObject,
  type AgentConfigEntryTarget,
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
} from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { reviewAutomationModelChange } from "../../lib/cron/model-impact.ts";
import { isWorkshopSkill } from "../../lib/skills-shared.ts";

export function createAgentConfigActions(params: {
  getRuntimeConfig: () => RuntimeConfigCapability;
  getReport: () => SkillStatusReport | null;
  canUpdate: (agentId: string) => boolean;
  onPrimaryChanged: () => void;
  modelChangeScope: () => Promise<void>;
  onModelImpact: (notice: string | null) => void;
}) {
  let modelChange = 0;
  function edit(
    agentId: string,
    ensure: boolean,
    apply: (config: RuntimeConfigCapability, target: AgentConfigEntryTarget) => void,
  ) {
    if (!params.canUpdate(agentId)) {
      return false;
    }
    const config = params.getRuntimeConfig();
    const target = config.agentEntry(agentId, { ensure });
    if (target) {
      apply(config, target);
    }
    // Inherited no-op selections still retain their primary-change callback.
    return true;
  }
  function tools(agentId: string, values: Record<string, unknown>, ensure: boolean) {
    edit(agentId, ensure, (config, target) => {
      for (const [field, value] of Object.entries(values)) {
        stage(config, [...target.path, "tools", field], value);
      }
    });
  }
  return {
    models: {
      onModelChange: async (agentId: string, modelId: string | null) => {
        if (!params.canUpdate(agentId)) {
          return;
        }
        const config = params.getRuntimeConfig();
        const client = config.state.client;
        if (!client) {
          return;
        }
        const epoch = currentConfigConnectionEpoch(config.state);
        const scope = params.modelChangeScope();
        const intent = ++modelChange;
        const isCurrent = () =>
          intent === modelChange &&
          scope === params.modelChangeScope() &&
          params.getRuntimeConfig() === config &&
          isCurrentConfigConnection(config.state, client, epoch) &&
          params.canUpdate(agentId);
        params.onModelImpact(null);
        if (
          !(await reviewAutomationModelChange(
            client,
            { model: modelId, agentId },
            { isCurrent, onNotice: params.onModelImpact, retired: scope },
          )) ||
          !isCurrent()
        ) {
          return;
        }
        if (
          edit(agentId, Boolean(modelId), (current, target) => {
            stage(
              current,
              [...target.path, "model"],
              modelShape(modelId, existingModelParts(target.entry.model).fallbacks),
            );
          })
        ) {
          params.onPrimaryChanged();
        }
      },
      onDecisionModelChange: (agentId: string, modelId: string | null) =>
        edit(agentId, modelId !== null, (config, target) =>
          stage(config, [...target.path, "decisionModel"], modelId ?? undefined),
        ),
      onModelFallbacksChange: (agentId: string, fallbacks: string[]) =>
        edit(agentId, true, (config, target) => {
          stage(
            config,
            [...target.path, "model"],
            modelShape(
              existingModelParts(target.entry.model).primary,
              normalizeStringEntries(fallbacks),
            ),
          );
        }),
    },
    tools: {
      onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) =>
        tools(
          agentId,
          { profile: profile || undefined, ...(clearAllow ? { allow: undefined } : {}) },
          Boolean(profile || clearAllow),
        ),
      onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) =>
        tools(
          agentId,
          {
            alsoAllow: alsoAllow.length ? alsoAllow : undefined,
            deny: deny.length ? deny : undefined,
          },
          alsoAllow.length > 0 || deny.length > 0,
        ),
    },
    skills: {
      onToggle: (agentId: string, skillName: string, enabled: boolean) =>
        edit(agentId, true, (config, target) => {
          if (!skillName.trim()) {
            return;
          }
          const path = [...target.path, "skills"];
          const configured = resolveAgentSkillsFilter(currentConfigObject(config.state), agentId);
          const report = params.getReport();
          const selectedSkillName = skillName.trim();
          // The first toggle snapshots reported skills; learned Workshop skills bypass allowlists.
          const next = new Set(
            configured ??
              report?.agentSkillFilter ??
              report?.skills
                .filter((skill) => skill.name && !isWorkshopSkill(skill))
                .map((skill) => skill.name) ??
              [],
          );
          if (enabled) {
            next.add(selectedSkillName);
          } else {
            next.delete(selectedSkillName);
          }
          stage(config, path, [...next]);
        }),
      onDisableAll: (agentId: string) =>
        edit(agentId, true, (config, target) => stage(config, [...target.path, "skills"], [])),
    },
  };
}

function stage(config: RuntimeConfigCapability, path: Array<string | number>, value: unknown) {
  if (value === undefined) {
    config.removeFormValue(path);
  } else {
    config.patchForm(path, value);
  }
}

// Keep bare strings, fallback-only overrides, and explicit empty fallback chains.
function modelShape(primary: string | null, fallbacks: unknown[] | null) {
  return !primary && !fallbacks
    ? undefined
    : primary && fallbacks
      ? { primary, fallbacks }
      : primary || { fallbacks };
}

function existingModelParts(existing: unknown): {
  primary: string | null;
  fallbacks: unknown[] | null;
} {
  if (typeof existing === "string") {
    return { primary: existing.trim() || null, fallbacks: null };
  }
  const record = asNullableRecord(existing);
  return {
    primary: typeof record?.primary === "string" ? record.primary.trim() || null : null,
    fallbacks: Array.isArray(record?.fallbacks) ? record.fallbacks : null,
  };
}
