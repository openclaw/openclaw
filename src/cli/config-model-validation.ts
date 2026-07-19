import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatCliCommand } from "./command-format.js";

type TouchedModelRef = {
  path: string;
  value: string;
  agentIndex?: number;
  fallback: boolean;
};

type ConfigModelRefResolver = (params: {
  config: OpenClawConfig;
  ref: TouchedModelRef;
}) => Promise<string | undefined>;

export type ConfigModelRefCheckResult = {
  refsChecked: number;
  refsTotal: number;
  errors: string[];
};

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function collectTextModelConfigRefs(params: {
  model: unknown;
  path: string;
  agentIndex?: number;
}): TouchedModelRef[] {
  if (typeof params.model === "string") {
    return [
      {
        path: params.path,
        value: params.model.trim(),
        ...(params.agentIndex === undefined ? {} : { agentIndex: params.agentIndex }),
        fallback: false,
      },
    ];
  }
  if (!params.model || typeof params.model !== "object" || Array.isArray(params.model)) {
    return [];
  }
  const model = params.model as { primary?: unknown; fallbacks?: unknown };
  const refs: TouchedModelRef[] = [];
  if (typeof model.primary === "string") {
    refs.push({
      path: `${params.path}.primary`,
      value: model.primary.trim(),
      ...(params.agentIndex === undefined ? {} : { agentIndex: params.agentIndex }),
      fallback: false,
    });
  }
  if (Array.isArray(model.fallbacks)) {
    for (const [index, fallback] of model.fallbacks.entries()) {
      if (typeof fallback !== "string") {
        continue;
      }
      refs.push({
        path: `${params.path}.fallbacks.${index}`,
        value: fallback.trim(),
        ...(params.agentIndex === undefined ? {} : { agentIndex: params.agentIndex }),
        fallback: true,
      });
    }
  }
  return refs;
}

function collectTextModelRefs(config: OpenClawConfig): TouchedModelRef[] {
  const refs = collectTextModelConfigRefs({
    model: config.agents?.defaults?.model,
    path: "agents.defaults.model",
  });
  for (const [agentIndex, agent] of (config.agents?.list ?? []).entries()) {
    refs.push(
      ...collectTextModelConfigRefs({
        model: agent.model,
        path: `agents.list.${agentIndex}.model`,
        agentIndex,
      }),
    );
  }
  return refs;
}

function collectTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
}): TouchedModelRef[] {
  const defaultPrimaryPath = ["agents", "defaults", "model", "primary"];
  const defaultPrimaryTouched = params.touchedPaths.some(
    (touchedPath) =>
      isPathPrefix(touchedPath, defaultPrimaryPath) ||
      isPathPrefix(defaultPrimaryPath, touchedPath),
  );
  return collectTextModelRefs(params.config).filter((ref) => {
    // Bare fallbacks inherit the global primary provider at runtime, including per-agent ones.
    if (ref.fallback && defaultPrimaryTouched && !ref.value.includes("/")) {
      return true;
    }
    const refPath = ref.path.split(".");
    return params.touchedPaths.some(
      (touchedPath) => isPathPrefix(touchedPath, refPath) || isPathPrefix(refPath, touchedPath),
    );
  });
}

function hasConfiguredModelAlias(config: OpenClawConfig, value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  return Object.values(config.agents?.defaults?.models ?? {}).some((entry) => {
    const alias = typeof entry?.alias === "string" ? entry.alias.trim().toLowerCase() : "";
    return alias.length > 0 && alias === normalizedValue;
  });
}

function validateModelRefSyntax(config: OpenClawConfig, value: string): string | undefined {
  if (!value) {
    return "Model reference is empty";
  }
  // Runtime model selection resolves configured aliases before parsing provider/model syntax.
  if (hasConfiguredModelAlias(config, value)) {
    return undefined;
  }
  const slash = value.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  return slash > 0 && slash < value.length - 1
    ? undefined
    : "Invalid model reference: expected provider/model or a configured model alias";
}

async function createRuntimeModelRefResolver(): Promise<ConfigModelRefResolver> {
  const [agentScope, modelSelection, modelRuntime, preparedCatalog] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/model-selection.js"),
    import("../agents/embedded-agent-runner/model.js"),
    import("../agents/prepared-model-catalog.js"),
  ]);
  const preparedByAgent = new Map<
    string,
    Awaited<ReturnType<typeof preparedCatalog.loadPreparedModelCatalogOwnerSnapshot>>
  >();

  return async ({ config, ref }) => {
    const configuredAgent =
      ref.agentIndex === undefined ? undefined : config.agents?.list?.[ref.agentIndex];
    const targetAgentId =
      typeof configuredAgent?.id === "string"
        ? configuredAgent.id
        : agentScope.resolveDefaultAgentId(config);
    const agentDir = agentScope.resolveAgentDir(config, targetAgentId);
    const workspaceDir = agentScope.resolveAgentWorkspaceDir(config, targetAgentId);
    const configuredPrimary = modelSelection.resolveDefaultModelForAgent({
      cfg: config,
      ...(ref.agentIndex === undefined ? {} : { agentId: targetAgentId }),
    });
    const defaultProvider = modelSelection.resolveDefaultModelForAgent({ cfg: config }).provider;
    const resolvedRef = ref.fallback
      ? modelSelection.resolveModelRefFromString({
          cfg: config,
          raw: ref.value,
          defaultProvider,
          aliasIndex: modelSelection.buildModelAliasIndex({
            cfg: config,
            defaultProvider,
          }),
        })?.ref
      : configuredPrimary;
    if (!resolvedRef) {
      return `Unknown model: ${ref.value}`;
    }

    let prepared = preparedByAgent.get(targetAgentId);
    if (!prepared) {
      prepared = await preparedCatalog.loadPreparedModelCatalogOwnerSnapshot({
        agentId: targetAgentId,
        agentDir,
        config,
        readOnly: true,
        workspaceDir,
      });
      preparedByAgent.set(targetAgentId, prepared);
    }
    const stores = prepared.createStores();
    const resolution = await modelRuntime.resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      agentDir,
      config,
      {
        agentId: targetAgentId,
        allowBundledStaticCatalogFallback: true,
        authStorage: stores.authStorage,
        modelRegistry: stores.modelRegistry,
        workspaceDir,
      },
    );
    return resolution.model
      ? undefined
      : (resolution.error ?? `Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  };
}

function formatModelRefError(ref: TouchedModelRef, error: string): string {
  const detail = error.endsWith(".") ? error : `${error}.`;
  return `Cannot set model reference "${ref.value}" at ${ref.path}: ${detail} Run ${formatCliCommand("openclaw models list")} to list available models.`;
}

export async function checkTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
  resolveModelRef?: ConfigModelRefResolver;
  createModelRefResolver?: () => Promise<ConfigModelRefResolver>;
}): Promise<ConfigModelRefCheckResult> {
  const refs = collectTouchedTextModelRefs(params);
  if (refs.length === 0) {
    return { refsChecked: 0, refsTotal: 0, errors: [] };
  }
  const syntaxFailures = refs.flatMap((ref) => {
    const error = validateModelRefSyntax(params.config, ref.value);
    return error ? [{ ref, error }] : [];
  });
  const refsToResolve = refs.filter((ref) => !validateModelRefSyntax(params.config, ref.value));
  const errors = syntaxFailures.map(({ ref, error }) => formatModelRefError(ref, error));
  if (refsToResolve.length === 0) {
    return { refsChecked: refs.length, refsTotal: refs.length, errors };
  }
  let resolveModelRef = params.resolveModelRef;
  if (!resolveModelRef) {
    try {
      resolveModelRef = await (params.createModelRefResolver ?? createRuntimeModelRefResolver)();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        refsChecked: syntaxFailures.length,
        refsTotal: refs.length,
        errors: [
          ...errors,
          `Unable to validate changed model references before writing: ${detail}`,
        ],
      };
    }
  }
  for (const ref of refsToResolve) {
    let error: string | undefined;
    try {
      error = await resolveModelRef({ config: params.config, ref });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    if (!error) {
      continue;
    }
    errors.push(formatModelRefError(ref, error));
  }
  return { refsChecked: refs.length, refsTotal: refs.length, errors };
}
