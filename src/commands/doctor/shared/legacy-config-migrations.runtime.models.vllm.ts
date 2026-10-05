import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { ensureRecord, getRecord, type LegacyConfigRule } from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
import {
  hasInvalidThinkingFormat,
  hasStaleContextWindowValue,
} from "./legacy-config-migrations.runtime.models.catalog.js";
import { visitAgentEntries } from "./legacy-config-record-shared.js";

const QWEN_THINKING_FORMAT_KEYS = ["qwenThinkingFormat", "qwen_thinking_format"] as const;

function normalizeLegacyVllmQwenThinkingFormat(
  value: unknown,
): "qwen" | "qwen-chat-template" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  switch (normalized) {
    case "chat-template":
    case "chat-template-argument":
    case "chat-template-arguments":
    case "chat-template-kwarg":
    case "chat-template-kwargs":
    case "qwen-chat-template":
      return "qwen-chat-template";
    case "enable-thinking":
    case "qwen":
    case "request-body":
    case "top-level":
      return "qwen";
    default:
      return undefined;
  }
}

function getLegacyVllmQwenThinkingFormat(params: Record<string, unknown>):
  | {
      key: (typeof QWEN_THINKING_FORMAT_KEYS)[number];
      value: unknown;
      compat: "qwen" | "qwen-chat-template" | undefined;
    }
  | undefined {
  for (const key of QWEN_THINKING_FORMAT_KEYS) {
    if (Object.hasOwn(params, key)) {
      return {
        key,
        value: params[key],
        compat: normalizeLegacyVllmQwenThinkingFormat(params[key]),
      };
    }
  }
  return undefined;
}

function parseVllmAgentModelKey(key: string): string | undefined {
  const trimmed = splitTrailingAuthProfile(key).model.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  const providerId = trimmed.slice(0, slashIndex);
  if (normalizeProviderId(providerId) !== "vllm") {
    return undefined;
  }
  const modelId = trimmed.slice(slashIndex + 1).trim();
  return modelId && modelId !== "*" ? modelId : undefined;
}

function hasLegacyVllmQwenThinkingFormat(defaultModels: unknown): boolean {
  return Object.entries(getRecord(defaultModels) ?? {}).some(
    ([key, entry]) =>
      parseVllmAgentModelKey(key) && hasLegacyVllmQwenThinkingParams(getRecord(entry)?.params),
  );
}

function hasLegacyVllmQwenThinkingModelParams(models: unknown): boolean {
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some((model) => hasLegacyVllmQwenThinkingParams(getRecord(model)?.params));
}

function hasLegacyVllmQwenThinkingParams(params: unknown): boolean {
  const record = getRecord(params);
  return Boolean(record && getLegacyVllmQwenThinkingFormat(record));
}

function hasLegacyVllmQwenThinkingAgentParams(agents: unknown): boolean {
  let found = false;
  visitAgentEntries({ agents }, (agent) => {
    found ||= hasLegacyVllmQwenThinkingParams(agent.params);
  });
  return found;
}

type ModelTarget = { model: Record<string, unknown>; index: number };

function resolveVllmModelTargets(
  raw: Record<string, unknown>,
  modelIds?: string[],
  includeExisting = false,
): ModelTarget[] {
  let provider = findVllmProvider(getRecord(getRecord(raw.models)?.providers));
  if (modelIds?.length) {
    const modelsRoot = getOrCreateRecord(raw, "models");
    const providers = modelsRoot ? getOrCreateRecord(modelsRoot, "providers") : undefined;
    const key = Object.keys(providers ?? {}).find((id) => normalizeProviderId(id) === "vllm");
    if (providers && !key) {
      provider = getOrCreateRecord(providers, "vllm");
    }
    if (provider && provider.models === undefined) {
      provider.models = [];
    }
  }
  const models = provider?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  const rows: ModelTarget[] = models.flatMap((model, index) => {
    const record = getRecord(model);
    return record ? [{ model: record, index }] : [];
  });
  if (!modelIds) {
    return rows;
  }
  const targets = includeExisting ? [...rows] : [];
  for (const id of modelIds) {
    let target = rows.find(({ model }) => model.id === id || model.id === `vllm/${id}`);
    if (!target) {
      target = { model: { id, name: id }, index: models.length };
      models.push(target.model);
      rows.push(target);
    }
    targets.push(target);
  }
  const seen = new Set<Record<string, unknown>>();
  return targets.filter(({ model }) => {
    if (seen.has(model)) {
      return false;
    }
    seen.add(model);
    return true;
  });
}

function collectVllmAgentModelIds(agent: Record<string, unknown> | null): string[] {
  return [
    ...listModelRefsFromConfigValue(agent?.model),
    ...Object.keys(getRecord(agent?.models) ?? {}),
  ].flatMap((ref) => {
    const modelId = parseVllmAgentModelKey(ref);
    return modelId ? [modelId] : [];
  });
}

function getOrCreateRecord(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (root[key] === undefined) {
    const next: Record<string, unknown> = {};
    root[key] = next;
    return next;
  }
  return getRecord(root[key]) ?? undefined;
}

function findVllmProvider(
  providers: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!providers) {
    return undefined;
  }
  const key = Object.keys(providers).find((entry) => normalizeProviderId(entry) === "vllm");
  return key ? (getRecord(providers[key]) ?? undefined) : undefined;
}

function hasLegacyVllmQwenThinkingNormalizedProvider(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord || getRecord(providersRecord.vllm)) {
    return false;
  }
  const vllmProvider = findVllmProvider(providersRecord);
  return (
    hasLegacyVllmQwenThinkingParams(vllmProvider?.params) ||
    hasLegacyVllmQwenThinkingModelParams(vllmProvider?.models)
  );
}

export function migrateVllmQwenThinkingParams(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const migrate = (
    owner: Record<string, unknown> | null | undefined,
    sourcePath: string,
    resolveTargets: (
      format: NonNullable<ReturnType<typeof getLegacyVllmQwenThinkingFormat>>,
    ) => ModelTarget[] | undefined,
  ) => {
    const params = getRecord(owner?.params);
    const format = params ? getLegacyVllmQwenThinkingFormat(params) : undefined;
    if (!owner || !params || !format) {
      return;
    }
    const targets = resolveTargets(format);
    if (!targets) {
      return;
    }
    for (const key of QWEN_THINKING_FORMAT_KEYS) {
      delete params[key];
    }
    if (targets.length === 0) {
      changes.push(
        `Removed ${sourcePath}.${format.key}; no concrete vLLM model row or agent model ref exists, so configure models.providers.vllm.models[].compat.thinkingFormat on each Qwen model that needs it.`,
      );
    }
    for (const { model, index } of targets) {
      if (!format.compat) {
        changes.push(
          `Removed ${sourcePath}.${format.key} (unrecognized value ${JSON.stringify(format.value)}; configure models.providers.vllm.models[].compat.thinkingFormat if needed).`,
        );
        continue;
      }
      if (model.reasoning === undefined) {
        model.reasoning = true;
      }
      const compat = ensureRecord(model, "compat");
      const current = compat.thinkingFormat;
      if (typeof current === "string" && isModelThinkingFormat(current)) {
        changes.push(
          `Removed ${sourcePath}.${format.key}; models.providers.vllm.models[${index}].compat.thinkingFormat is already ${JSON.stringify(current)}.`,
        );
      } else {
        compat.thinkingFormat = format.compat;
        changes.push(
          `Moved ${sourcePath}.${format.key} to models.providers.vllm.models[${index}].compat.thinkingFormat (${JSON.stringify(format.compat)}).`,
        );
      }
    }
    if (Object.keys(params).length === 0) {
      delete owner.params;
    }
  };
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  for (const [key, entry] of Object.entries(getRecord(defaults?.models) ?? {})) {
    const id = parseVllmAgentModelKey(key);
    if (id) {
      migrate(
        getRecord(entry),
        `agents.defaults.models.${JSON.stringify(key)}.params`,
        (format) => {
          const targets = format.compat
            ? resolveVllmModelTargets(raw, [id])
            : [{ model: {}, index: -1 }];
          return targets.length > 0 ? targets : undefined;
        },
      );
    }
  }
  for (const target of resolveVllmModelTargets(raw)) {
    migrate(target.model, `models.providers.vllm.models[${target.index}].params`, () => [target]);
  }
  const defaultIds = collectVllmAgentModelIds(defaults);
  const agents: Array<{ agent: Record<string, unknown>; path: string }> = [];
  visitAgentEntries(raw, (agent, path) => agents.push({ agent, path }));
  const provider = findVllmProvider(getRecord(getRecord(raw.models)?.providers));
  migrate(provider, "models.providers.vllm.params", () =>
    resolveVllmModelTargets(
      raw,
      [...defaultIds, ...agents.flatMap(({ agent }) => collectVllmAgentModelIds(agent))],
      true,
    ),
  );
  const selectedTargets = (ids: string[]) =>
    resolveVllmModelTargets(raw, ids.length ? ids : undefined);
  migrate(defaults, "agents.defaults.params", () => selectedTargets(defaultIds));
  for (const { agent, path } of agents) {
    migrate(agent, `${path}.params`, () => {
      const ids = collectVllmAgentModelIds(agent);
      return selectedTargets(ids.length ? ids : defaultIds);
    });
  }
}

export const LEGACY_VLLM_QWEN_THINKING_FORMAT_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "models"],
    message:
      'agents.defaults.models.<vllm-model>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingFormat,
  },
  {
    path: ["models", "providers", "vllm", "params"],
    message:
      'models.providers.vllm.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingParams,
  },
  {
    path: ["models", "providers", "vllm", "models"],
    message:
      'models.providers.vllm.models[*].params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingModelParams,
  },
  {
    path: ["models", "providers"],
    message:
      'models.providers.<vllm>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.<vllm>.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingNormalizedProvider,
  },
  {
    path: ["agents", "defaults", "params"],
    message:
      'agents.defaults.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingParams,
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
    match: hasLegacyVllmQwenThinkingAgentParams,
  },
];

export const INVALID_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run "openclaw doctor --fix" to remove it and restore the runtime default.',
  match: hasInvalidThinkingFormat,
};

export const STALE_CONTEXT_WINDOW_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].contextWindow has a stale catalog value; run "openclaw doctor --fix" to repair it.',
  match: hasStaleContextWindowValue,
};
