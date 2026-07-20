import {
  resolveAgentExplicitModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { loadPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatCliCommand } from "./command-format.js";

type TouchedModelRef = {
  path: string;
  value: string;
  agentIndex?: number;
  agentId?: string;
  fallback: boolean;
  authProfileId?: string;
};

type ConfigModelRefResolver = (params: {
  config: OpenClawConfig;
  ref: TouchedModelRef;
}) => Promise<string | undefined>;

type ConfigModelRefCheckResult = {
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
  agentId?: string;
}): TouchedModelRef[] {
  if (typeof params.model === "string") {
    const value = params.model.trim();
    return [
      {
        path: params.path,
        value,
        ...(params.agentIndex === undefined ? {} : { agentIndex: params.agentIndex }),
        ...(params.agentId ? { agentId: params.agentId } : {}),
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
    const value = model.primary.trim();
    refs.push({
      path: `${params.path}.primary`,
      value,
      ...(params.agentIndex === undefined ? {} : { agentIndex: params.agentIndex }),
      ...(params.agentId ? { agentId: params.agentId } : {}),
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
        ...(params.agentId ? { agentId: params.agentId } : {}),
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
  const agentList = config.agents?.list;
  if (Array.isArray(agentList)) {
    for (const [agentIndex, agent] of agentList.entries()) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        continue;
      }
      refs.push(
        ...collectTextModelConfigRefs({
          model: (agent as { model?: unknown }).model,
          path: `agents.list.${agentIndex}.model`,
          agentIndex,
          ...(typeof agent.id === "string" ? { agentId: agent.id } : {}),
        }),
      );
    }
  }
  for (const ref of refs) {
    // Runtime preserves an auth-profile suffix only for configured primaries. Fallback
    // candidates carry provider/model pairs, so validation must mirror that behavior.
    if (ref.fallback || hasConfiguredModelAlias(config, ref.value)) {
      continue;
    }
    const authProfileId = splitTrailingAuthProfile(ref.value).profile;
    if (authProfileId) {
      ref.authProfileId = authProfileId;
    }
  }
  return refs;
}

function collectTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
}): TouchedModelRef[] {
  const defaultPrimaryPath = ["agents", "defaults", "model", "primary"];
  const defaultPrimaryTouched = params.touchedPaths.some(
    (touchedPath) =>
      isPathPrefix(touchedPath, defaultPrimaryPath) ||
      isPathPrefix(defaultPrimaryPath, touchedPath),
  );
  const refs = collectTextModelRefs(params.config);
  const previousRefs = params.previousConfig
    ? collectTextModelRefs(params.previousConfig)
    : undefined;
  const previousRefsByPath = previousRefs
    ? new Map(previousRefs.map((ref) => [ref.path, ref]))
    : undefined;
  const defaultPrimaryProviderChanged =
    defaultPrimaryTouched &&
    (!previousRefs ||
      resolveDefaultModelForAgent({ cfg: params.config }).provider !==
        resolveDefaultModelForAgent({ cfg: params.previousConfig ?? {} }).provider);
  return refs.filter((ref) => {
    // Bare fallbacks inherit the global primary provider at runtime, including per-agent ones.
    if (ref.fallback && defaultPrimaryProviderChanged && !ref.value.includes("/")) {
      return true;
    }
    const refPath = ref.path.split(".");
    const agentIdPath =
      ref.agentIndex === undefined ? undefined : ["agents", "list", String(ref.agentIndex), "id"];
    if (
      agentIdPath &&
      params.touchedPaths.some(
        (touchedPath) =>
          isPathPrefix(touchedPath, agentIdPath) || isPathPrefix(agentIdPath, touchedPath),
      )
    ) {
      return true;
    }
    const touched = params.touchedPaths.some(
      (touchedPath) => isPathPrefix(touchedPath, refPath) || isPathPrefix(refPath, touchedPath),
    );
    if (!touched || !previousRefsByPath) {
      return touched;
    }
    const previousRef = previousRefsByPath.get(ref.path);
    return previousRef?.value !== ref.value || previousRef?.agentId !== ref.agentId;
  });
}

function hasConfiguredModelAlias(config: OpenClawConfig, value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  return Object.values(config.agents?.defaults?.models ?? {}).some((entry) => {
    const alias = typeof entry?.alias === "string" ? entry.alias.trim().toLowerCase() : "";
    return alias.length > 0 && alias === normalizedValue;
  });
}

function expandInheritedDefaultRefs(
  config: OpenClawConfig,
  refs: TouchedModelRef[],
): TouchedModelRef[] {
  const agentList = config.agents?.list;
  if (!Array.isArray(agentList)) {
    return refs;
  }
  const defaultAgentId = resolveDefaultAgentId(config);
  const expanded: TouchedModelRef[] = [];
  for (const ref of refs) {
    expanded.push(ref);
    if (ref.agentIndex !== undefined) {
      continue;
    }
    for (const [agentIndex, agent] of agentList.entries()) {
      const agentId = typeof agent?.id === "string" ? agent.id : "";
      if (!agentId || agentId === defaultAgentId) {
        continue;
      }
      const inherits = ref.fallback
        ? resolveAgentModelFallbacksOverride(config, agentId) === undefined
        : resolveAgentExplicitModelPrimary(config, agentId) === undefined;
      if (inherits) {
        expanded.push({ ...ref, agentIndex, agentId });
      }
    }
  }
  return expanded;
}

function validateModelRefSyntax(config: OpenClawConfig, value: string): string | undefined {
  if (!value) {
    return "Model reference is empty";
  }
  const model = splitTrailingAuthProfile(value).model;
  // Runtime model selection resolves configured aliases before parsing provider/model syntax.
  if (hasConfiguredModelAlias(config, value) || hasConfiguredModelAlias(config, model)) {
    return undefined;
  }
  const slash = model.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  return slash > 0 && slash < model.length - 1
    ? undefined
    : "Invalid model reference: expected provider/model or a configured model alias";
}

async function createRuntimeModelRefResolver(): Promise<ConfigModelRefResolver> {
  const [agentScope, modelSelection] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/model-selection.js"),
  ]);
  const preparedByAgent = new Map<
    string,
    Awaited<ReturnType<typeof loadPreparedModelCatalogOwnerSnapshot>>
  >();
  let modelModules:
    | Promise<
        [
          typeof import("../agents/embedded-agent-runner/model.js"),
          typeof import("../agents/prepared-model-catalog.js"),
        ]
      >
    | undefined;
  const loadModelModules = () =>
    (modelModules ??= Promise.all([
      import("../agents/embedded-agent-runner/model.js"),
      import("../agents/prepared-model-catalog.js"),
    ]));

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
    // CLI backends own model validation; their model ids do not need embedded catalog rows.
    if (modelSelection.isCliProvider(resolvedRef.provider, config)) {
      return undefined;
    }
    const [modelRuntime, preparedCatalog] = await loadModelModules();

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
        ...(ref.authProfileId ? { authProfileId: ref.authProfileId } : {}),
        modelRegistry: stores.modelRegistry,
        workspaceDir,
      },
    );
    return resolution.model
      ? undefined
      : (resolution.error ?? `Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  };
}

function formatModelRefError(
  ref: TouchedModelRef,
  error: string,
  authoredValue = ref.value,
): string {
  const safeError =
    authoredValue !== ref.value ? "Unable to resolve authored model reference" : error;
  const detail = safeError.endsWith(".") ? safeError : `${safeError}.`;
  return `Cannot set model reference "${authoredValue}" at ${ref.path}: ${detail} Run ${formatCliCommand("openclaw models list")} to list available models.`;
}

export async function checkTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
  env?: NodeJS.ProcessEnv;
  resolveModelRef?: ConfigModelRefResolver;
  createModelRefResolver?: () => Promise<ConfigModelRefResolver>;
}): Promise<ConfigModelRefCheckResult> {
  const authoredRefs = collectTouchedTextModelRefs(params);
  if (authoredRefs.length === 0) {
    return { refsChecked: 0, refsTotal: 0, errors: [] };
  }
  const authoredValuesByPath = new Map(
    collectTextModelRefs(params.config).map((ref) => [ref.path, ref.value]),
  );
  let validationConfig: OpenClawConfig;
  try {
    validationConfig = resolveConfigEnvVars(
      params.config,
      params.env ?? process.env,
    ) as OpenClawConfig;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      refsChecked: 0,
      refsTotal: authoredRefs.length,
      errors: [`Unable to validate changed model references before writing: ${detail}`],
    };
  }
  const refs = expandInheritedDefaultRefs(
    validationConfig,
    collectTouchedTextModelRefs({
      config: validationConfig,
      previousConfig: params.previousConfig,
      touchedPaths: params.touchedPaths,
    }),
  );
  if (refs.length === 0) {
    return { refsChecked: 0, refsTotal: 0, errors: [] };
  }
  const syntaxFailures = refs.flatMap((ref) => {
    const error = validateModelRefSyntax(validationConfig, ref.value);
    return error ? [{ ref, error }] : [];
  });
  const refsToResolve = refs.filter((ref) => !validateModelRefSyntax(validationConfig, ref.value));
  const errors = syntaxFailures.map(({ ref, error }) =>
    formatModelRefError(ref, error, authoredValuesByPath.get(ref.path)),
  );
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
  let refsChecked = syntaxFailures.length;
  for (const ref of refsToResolve) {
    let error: string | undefined;
    try {
      error = await resolveModelRef({ config: validationConfig, ref });
      refsChecked += 1;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      errors.push(
        formatModelRefError(
          ref,
          `Unable to validate model reference: ${detail}`,
          authoredValuesByPath.get(ref.path),
        ),
      );
      continue;
    }
    if (!error) {
      continue;
    }
    errors.push(formatModelRefError(ref, error, authoredValuesByPath.get(ref.path)));
  }
  return { refsChecked, refsTotal: refs.length, errors };
}
