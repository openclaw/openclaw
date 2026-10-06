import {
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { materializeModelPolicyAllowlist } from "../../../config/model-policy-allowlist-migration.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
import { materializeUtilityModelSeparation } from "../../../config/utility-model-separation-migration.js";
import { containsAuthoredInclude } from "./include-migration-ownership.js";
import * as catalog from "./legacy-config-migrations.runtime.models.catalog.js";
import * as codex from "./legacy-config-migrations.runtime.models.codex.js";
import * as refs from "./legacy-config-migrations.runtime.models.refs.js";
import * as vllm from "./legacy-config-migrations.runtime.models.vllm.js";
import {
  collectLegacyDefaultModelAllowRefs,
  migrateExplicitDefaultModelAllowPolicy,
} from "./legacy-runtime-model-policy.js";

export { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";
export type { BlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS: LegacyConfigMigrationSpec[] = [
  {
    id: "defaultModel->agents.defaults.model",
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
  },
  {
    id: "runtime.utility-model-separation",
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
  },
  {
    id: "models.pricing-retired",
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
  },
  {
    id: "models.providers.*.models.*.compat->provider-catalog",
    legacyRules: catalog.MODEL_COMPAT_CATALOG_RULES,
    apply: catalog.migrateModelCompatCatalogOwnership,
  },
  {
    id: "models.providers.codex-routes->models.providers.openai",
    legacyRules: [
      {
        path: ["models", "providers"],
        message:
          'models.providers.codex and models.providers.openai-codex are legacy; run "openclaw doctor --fix" to move them to models.providers.openai.',
        match: (value, root) => codex.hasAutoFixableLegacyOpenAICodexProvider(value, root),
      },
    ],
    apply: codex.migrateLegacyOpenAICodexProvider,
  },
  {
    id: "models.canonical-model-refs",
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
  },
  {
    id: "agents.defaults.models->agents.defaults.modelPolicy.allow",
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
  },
  {
    id: "agents.defaults.models.vllm.params.qwenThinkingFormat->models.providers.vllm.models.compat.thinkingFormat",
    legacyRules: vllm.LEGACY_VLLM_QWEN_THINKING_FORMAT_RULES,
    apply: vllm.migrateVllmQwenThinkingParams,
  },
  {
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
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
  },
  {
    id: "models.providers.*.models.*.contextWindow-stale",
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
  },
];
