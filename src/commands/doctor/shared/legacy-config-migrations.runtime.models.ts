import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
} from "../../../config/legacy.shared.js";
import { materializeModelPolicyAllowlist } from "../../../config/model-policy-allowlist-migration.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
import { materializeUtilityModelSeparation } from "../../../config/utility-model-separation-migration.js";
import { containsAuthoredInclude } from "./include-migration-ownership.js";
import * as catalog from "./legacy-config-migrations.runtime.models.catalog.js";
import * as codex from "./legacy-config-migrations.runtime.models.codex.js";
import * as refs from "./legacy-config-migrations.runtime.models.refs.js";
import * as vllm from "./legacy-config-migrations.runtime.models.vllm.js";
import { visitAgentEntries } from "./legacy-config-record-shared.js";
import {
  collectLegacyDefaultModelAllowRefs,
  migrateExplicitDefaultModelAllowPolicy,
} from "./legacy-runtime-model-policy.js";

export { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";
export type { BlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";

function migrateVllmThinkingParams(
  owner: Record<string, unknown> | null | undefined,
  sourcePath: string,
  changes: string[],
  resolveTargets: (
    format: NonNullable<ReturnType<typeof vllm.getLegacyVllmQwenThinkingFormat>>,
  ) => ReturnType<typeof vllm.listExistingVllmModelTargets> | undefined,
): void {
  const params = getRecord(owner?.params);
  const legacyFormat = params ? vllm.getLegacyVllmQwenThinkingFormat(params) : undefined;
  if (!owner || !params || !legacyFormat) {
    return;
  }
  const targets = resolveTargets(legacyFormat);
  if (!targets) {
    return;
  }
  vllm.applyLegacyVllmQwenThinkingFormatToTargets({
    sourcePath,
    legacyParams: params,
    targets,
    legacyFormat,
    changes,
  });
  if (Object.keys(params).length === 0) {
    delete owner.params;
  }
}

/** Legacy config migration specs for model/provider runtime config compatibility. */
const LEGACY_DEFAULT_MODEL_MIGRATION = defineLegacyConfigMigration({
  id: "defaultModel->agents.defaults.model",
  describe: "Move the retired root default model to agent defaults",
  legacyRules: [
    {
      path: ["defaultModel"],
      message: 'defaultModel moved to agents.defaults.model. Run "openclaw doctor --fix".',
    },
  ],
  apply: (raw, changes) => {
    if (!Object.hasOwn(raw, "defaultModel")) {
      return;
    }
    const legacyDefaultModel = raw.defaultModel;
    const currentDefaults = getRecord(getRecord(raw.agents)?.defaults);
    if (currentDefaults?.model === undefined && typeof legacyDefaultModel === "string") {
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      defaults.model = legacyDefaultModel;
      changes.push("Moved defaultModel → agents.defaults.model.");
    } else {
      changes.push("Removed defaultModel (agents.defaults.model already set or value invalid).");
    }
    delete raw.defaultModel;
  },
});

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS = [
  LEGACY_DEFAULT_MODEL_MIGRATION,
  defineLegacyConfigMigration({
    id: "runtime.utility-model-separation",
    describe: "Preserve the legacy implicit primary before separating utility models",
    legacyRules: [
      {
        path: ["agents"],
        message:
          'Legacy implicit primary model selection needs preservation before separating utility models. Run "openclaw doctor --fix"; dynamic catalog IDs need an explicit primary model.',
        // Advice may inspect resolved values; applying the migration still requires authored input.
        match: (_value, root) =>
          materializeUtilityModelSeparation(structuredClone(root)).changes.length > 0,
      },
    ],
    apply: (raw, changes, context) => {
      // Includes need the writer's resolved authored env map; a resolved literal cannot prove intent.
      if (context && containsAuthoredInclude(context.authoredRaw)) {
        return;
      }
      const migrated = materializeUtilityModelSeparation(raw, context?.authoredRaw ?? raw);
      // Marker-only conversion is stamped by the config writer, not an unrelated Doctor repair.
      if (migrated.changes.length === 0) {
        return;
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
  defineLegacyConfigMigration({
    id: "models.pricing-retired",
    describe: "Remove the retired client-side model pricing bootstrap toggle",
    legacyRules: [
      {
        path: ["models", "pricing"],
        message:
          'models.pricing is retired because pricing ships with the hosted catalog; run "openclaw doctor --fix" to remove it.',
      },
    ],
    apply: (raw, changes) => {
      const models = getRecord(raw.models);
      if (!models || !Object.hasOwn(models, "pricing")) {
        return;
      }
      delete models.pricing;
      changes.push("Removed models.pricing (pricing now ships with the hosted model catalog).");
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat->provider-catalog",
    describe: "Move known-model compatibility capability ownership into provider catalogs",
    legacyRules: catalog.MODEL_COMPAT_CATALOG_RULES,
    apply: catalog.migrateModelCompatCatalogOwnership,
  }),
  defineLegacyConfigMigration({
    id: "models.providers.codex-routes->models.providers.openai",
    describe: "Move legacy Codex-route provider config to canonical OpenAI provider config",
    legacyRules: [
      {
        path: ["models", "providers"],
        message:
          'models.providers.codex and models.providers.openai-codex are legacy; run "openclaw doctor --fix" to move them to models.providers.openai.',
        match: (value, root) => codex.hasAutoFixableLegacyOpenAICodexProvider(value, root),
      },
      {
        path: ["models", "providers"],
        message:
          'openai-codex-responses is legacy; run "openclaw doctor --fix" to use openai-chatgpt-responses.',
        match: (value) => {
          const providers = getRecord(value);
          return providers
            ? Object.values(providers).some((providerValue) => {
                const provider = getRecord(providerValue);
                return (
                  provider?.api === codex.LEGACY_OPENAI_CODEX_RESPONSES_API ||
                  (Array.isArray(provider?.models) &&
                    provider.models.some(
                      (model) => getRecord(model)?.api === codex.LEGACY_OPENAI_CODEX_RESPONSES_API,
                    ))
                );
              })
            : false;
        },
      },
    ],
    apply: codex.migrateLegacyOpenAICodexProvider,
  }),
  defineLegacyConfigMigration({
    id: "models.canonical-model-refs",
    describe: "Canonicalize retired and noncanonical model refs",
    legacyRules: codex.MODEL_REF_CANONICALIZATION_RULES,
    apply: (raw, changes) => {
      const rewritten = refs.rewriteKnownModelRefs(raw, "config", changes);
      const rewrittenRecord = getRecord(rewritten.value);
      if (!rewritten.changed || !rewrittenRecord) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      for (const [key, value] of Object.entries(rewrittenRecord)) {
        refs.setRecordEntry(raw, key, value);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models->agents.defaults.modelPolicy.allow",
    describe: "Make the legacy model override restriction explicit",
    legacyRules: [
      {
        path: ["agents", "defaults", "models"],
        message:
          'Legacy agents.defaults.models restricts model overrides; run "openclaw doctor --fix" to migrate valid refs to agents.defaults.modelPolicy.allow.',
        match: (_value, root) => collectLegacyDefaultModelAllowRefs(root) !== null,
      },
      {
        path: ["agents", "defaults", "models"],
        message:
          "Legacy model restriction retained: some keys need explicit provider/model refs. Set agents.defaults.modelPolicy.allow to the intended restriction; until then, editing agents.defaults.models still changes the restriction.",
        match: (_value, root) => materializeModelPolicyAllowlist(root).kind === "deferred",
      },
    ],
    apply: migrateExplicitDefaultModelAllowPolicy,
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models.vllm.params.qwenThinkingFormat->models.providers.vllm.models.compat.thinkingFormat",
    describe: "Move legacy vLLM Qwen thinking params to model compat metadata",
    legacyRules: [
      vllm.LEGACY_VLLM_QWEN_AGENT_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_PROVIDER_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_PROVIDER_MODEL_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_NORMALIZED_PROVIDER_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_DEFAULT_PARAMS_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_AGENT_PARAMS_THINKING_FORMAT_RULE,
    ],
    apply: (raw, changes) => {
      const agentsDefaults = getRecord(getRecord(raw.agents)?.defaults);
      const defaultModels = getRecord(agentsDefaults?.models);
      for (const [key, entry] of Object.entries(defaultModels ?? {})) {
        const modelId = vllm.parseVllmAgentModelKey(key);
        if (!modelId) {
          continue;
        }
        migrateVllmThinkingParams(
          getRecord(entry),
          `agents.defaults.models.${JSON.stringify(key)}.params`,
          changes,
          (format) => {
            const target = format.compat
              ? vllm.findOrCreateVllmModelEntry(raw, modelId)
              : { model: {}, index: -1 };
            return target ? [target] : undefined;
          },
        );
      }

      const vllmProvider = vllm.findVllmProvider(getRecord(getRecord(raw.models)?.providers));
      const vllmModels = vllmProvider?.models;
      if (Array.isArray(vllmModels)) {
        for (const [index, model] of vllmModels.entries()) {
          const modelRecord = getRecord(model);
          if (modelRecord) {
            migrateVllmThinkingParams(
              modelRecord,
              `models.providers.vllm.models[${index}].params`,
              changes,
              () => [{ model: modelRecord, index }],
            );
          }
        }
      }

      // Default selections and model-map keys stay fixed while params and provider rows migrate.
      let cachedDefaultModelIds: string[] | undefined;
      const getDefaultModelIds = () =>
        (cachedDefaultModelIds ??= [
          ...vllm.collectVllmModelIdsFromSelection(agentsDefaults?.model),
          ...vllm.collectVllmModelIdsFromAgentModelMap(defaultModels),
        ]);
      migrateVllmThinkingParams(vllmProvider, "models.providers.vllm.params", changes, () =>
        vllm.combineVllmModelTargets(
          vllm.listExistingVllmModelTargets(raw),
          vllm.createVllmModelTargets(raw, [
            ...getDefaultModelIds(),
            ...vllm.collectVllmModelIdsFromAgentRoster(raw),
          ]),
        ),
      );
      const targetsForSelection = (modelIds: string[]) =>
        modelIds.length > 0
          ? vllm.createVllmModelTargets(raw, modelIds)
          : vllm.listExistingVllmModelTargets(raw);
      migrateVllmThinkingParams(agentsDefaults, "agents.defaults.params", changes, () =>
        targetsForSelection(getDefaultModelIds()),
      );
      visitAgentEntries(raw, (agentRecord, path) => {
        migrateVllmThinkingParams(agentRecord, `${path}.params`, changes, () => {
          const explicitAgentModelIds = [
            ...vllm.collectVllmModelIdsFromSelection(agentRecord.model),
            ...vllm.collectVllmModelIdsFromAgentModelMap(agentRecord.models),
          ];
          return targetsForSelection(
            explicitAgentModelIds.length > 0 ? explicitAgentModelIds : getDefaultModelIds(),
          );
        });
      });
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
    describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
    legacyRules: [vllm.INVALID_THINKING_FORMAT_RULE],
    apply: (raw, changes) => {
      for (const { providerId, modelIndex, model } of catalog.providerModelEntries(
        getRecord(raw.models)?.providers,
      )) {
        const compat = getRecord(model.compat);
        const thinkingFormat = compat?.thinkingFormat;
        if (
          !compat ||
          typeof thinkingFormat !== "string" ||
          isModelThinkingFormat(thinkingFormat)
        ) {
          continue;
        }
        delete compat.thinkingFormat;
        changes.push(
          `Removed models.providers.${providerId}.models.${modelIndex}.compat.thinkingFormat (unrecognized value ${JSON.stringify(thinkingFormat)}; runtime default applies).`,
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.contextWindow-stale",
    describe: "Repair stale contextWindow values to match catalog defaults",
    legacyRules: [vllm.STALE_CONTEXT_WINDOW_RULE],
    apply: (raw, changes) => {
      for (const { providerId, modelIndex, model } of catalog.providerModelEntries(
        getRecord(raw.models)?.providers,
      )) {
        const modelId = typeof model.id === "string" ? model.id : undefined;
        const contextWindow = model.contextWindow;
        if (!modelId || typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
          continue;
        }
        const fix = catalog.resolveStaleContextWindowFix({ providerId, modelId, contextWindow });
        if (!fix) {
          continue;
        }
        model.contextWindow = fix.correct;
        changes.push(
          `Repaired models.providers.${providerId}.models[${modelIndex}].${modelId}.contextWindow (${contextWindow} → ${fix.correct} to match catalog default).`,
        );
      }
    },
  }),
];
