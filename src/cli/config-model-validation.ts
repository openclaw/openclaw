import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
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

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function parseTextModelRef(path: string, value: string): TouchedModelRef | undefined {
  const segments = path.split(".");
  if (segments[0] !== "agents") {
    return undefined;
  }
  if (segments[1] === "defaults" && segments[2] === "model") {
    return { path, value, fallback: segments[3] === "fallbacks" };
  }
  if (segments[1] !== "list" || !/^\d+$/.test(segments[2] ?? "") || segments[3] !== "model") {
    return undefined;
  }
  return {
    path,
    value,
    agentIndex: Number(segments[2]),
    fallback: segments[4] === "fallbacks",
  };
}

function collectTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
}): TouchedModelRef[] {
  return collectConfiguredModelRefs(params.config)
    .map(({ path, value }) => parseTextModelRef(path, value))
    .filter((ref): ref is TouchedModelRef => {
      if (!ref) {
        return false;
      }
      const refPath = ref.path.split(".");
      return params.touchedPaths.some(
        (touchedPath) => isPathPrefix(touchedPath, refPath) || isPathPrefix(refPath, touchedPath),
      );
    });
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

export async function validateTouchedTextModelRefs(params: {
  config: OpenClawConfig;
  touchedPaths: readonly (readonly string[])[];
  resolveModelRef?: ConfigModelRefResolver;
}): Promise<number> {
  const refs = collectTouchedTextModelRefs(params);
  if (refs.length === 0) {
    return 0;
  }
  const resolveModelRef = params.resolveModelRef ?? (await createRuntimeModelRefResolver());
  for (const ref of refs) {
    const error = await resolveModelRef({ config: params.config, ref });
    if (!error) {
      continue;
    }
    const detail = error.endsWith(".") ? error : `${error}.`;
    throw new Error(
      `Cannot set model reference "${ref.value}" at ${ref.path}: ${detail} Run ${formatCliCommand("openclaw models list")} to list available models.`,
    );
  }
  return refs.length;
}
