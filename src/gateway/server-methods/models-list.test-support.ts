// Shared mocks and lifecycle for the focused models suites.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, vi } from "vitest";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { PreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { assertPluginMetadataSnapshotConsistency } from "../plugin-metadata.test-helpers.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

export const OPENCLAW_DEVICE_PLACEMENT: NonNullable<GatewayAgentRuntime["devicePlacement"]> = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

const modelPluginMetadataSnapshot = await vi.hoisted(async () => {
  const { createModelPluginMetadataSnapshot } = await import("./models-metadata.test-support.js");
  return createModelPluginMetadataSnapshot();
});

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-thinking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-thinking.js")>()),
  resolveEffectiveThinkingProfile: (params: { provider: string; context: { modelId: string } }) => {
    if (params.provider !== "claude-cli") {
      return undefined;
    }
    if (params.context.modelId === "claude-mythos-5") {
      return { levels: [{ id: "off" }], defaultLevel: "off" };
    }
    if (params.context.modelId === "claude-fable-5") {
      return {
        levels: [
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "adaptive" },
          { id: "max" },
        ],
        defaultLevel: "high",
        preserveWhenCatalogReasoningFalse: true,
      };
    }
    return undefined;
  },
}));

export const withoutOpenAIEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      CODEX_API_KEY: undefined,
      CODEX_HOME: "/__openclaw_models_list_test__/codex",
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
      CHATGPT_OAUTH_TOKEN: undefined,
    },
    run,
  );

export const withoutAnthropicEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      HOME: modelsTestState.home,
    },
    run,
  );

let modelsTestState: OpenClawTestState;

export async function withModelsTestState<T>(
  options: { env?: Record<string, string | undefined> },
  run: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  clearRuntimeAuthProfileStoreSnapshots();
  await modelsTestState.writeAuthProfiles({ version: 1, profiles: {} });
  try {
    return await withEnvAsync(options.env ?? {}, () => run(modelsTestState));
  } finally {
    clearRuntimeAuthProfileStoreSnapshots();
  }
}

export function createDemoOAuthStore(params: { access: string; expires: number }) {
  return {
    version: 1 as const,
    profiles: {
      "demo-provider:oauth": {
        type: "oauth" as const,
        provider: "demo-provider",
        access: params.access,
        refresh: "refresh-token",
        expires: params.expires,
      },
    },
  };
}

export function catalogLoader(entries: Array<Record<string, unknown>>) {
  return vi.fn(async () => entries);
}

export function requestModelsList(params: {
  view: "default" | "configured" | "provider-config" | "all";
  agentId?: string;
  runtimeConfig?: OpenClawConfig;
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
  includeDefaultModels?: boolean;
  includeProviderCapabilities?: boolean;
  deferredAuth?: Promise<PreparedModelRuntimeAuth>;
  refresh?: boolean;
  publishedCatalog?: ModelCatalogEntry[];
  catalogComplete?: boolean;
  preparedAuthModes?: PreparedModelRuntimeAuth["authModes"];
}) {
  const respond = vi.fn();
  const runtimeConfig = params.runtimeConfig ?? {};
  const getRuntimeConfig = () => runtimeConfig;
  const resolveOwnerFacts = () => {
    const config = getRuntimeConfig();
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    return {
      agentId,
      agentDir,
      workspaceDir: agentDir,
      config,
      observationConfig: config,
      isCurrent: () => getRuntimeConfig() === config,
      authModes: params.preparedAuthModes ?? {},
      authStore:
        getPreparedRuntimeAuthProfileStoreSnapshot(agentDir) ??
        loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
    };
  };
  const loadSnapshot = async (loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0]) => {
    const entries = await params.loadGatewayModelCatalog(loadParams);
    const owner = resolveOwnerFacts();
    return {
      ...owner,
      ...(loadParams?.agentId ? { agentId: loadParams.agentId } : {}),
      catalogComplete: params.catalogComplete ?? loadParams?.readOnly === false,
      entries,
      routeVariants: entries,
      authMaterializations: [],
    } as unknown as PreparedGatewayModelCatalogSnapshot;
  };
  const loadGatewayModelCatalogSnapshot = async (
    loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0],
  ) => loadSnapshot(loadParams);
  let published: PreparedGatewayModelCatalogSnapshot | undefined;
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: async (loadParams) => {
      const snapshot = await loadSnapshot(loadParams);
      published = snapshot;
      if (!params.deferredAuth) {
        return snapshot;
      }
      published = { ...snapshot, ...(await params.deferredAuth) };
      return published;
    },
    readPrepared: async () => {
      if (published && published.config === getRuntimeConfig()) {
        return published;
      }
      published = params.publishedCatalog
        ? {
            ...resolveOwnerFacts(),
            catalogComplete: false,
            entries: params.publishedCatalog,
            routeVariants: params.publishedCatalog,
            authMaterializations: [],
          }
        : await loadSnapshot({ agentId: params.agentId, readOnly: true });
      return published;
    },
  });
  const requestParams = {
    view: params.view,
    ...(params.includeDefaultModels === undefined
      ? {}
      : { includeDefaultModels: params.includeDefaultModels }),
    ...(params.refresh ? { refresh: true } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
  };
  const request = expectDefined(
    modelsHandlers["models.list"],
    'modelsHandlers["models.list"] test invariant',
  )({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: requestParams,
    },
    params: requestParams,
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      logGateway: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}

export function setupModelsListFixture() {
  beforeAll(async () => {
    assertPluginMetadataSnapshotConsistency(modelPluginMetadataSnapshot as PluginMetadataSnapshot);
    modelsTestState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-models-list-",
      agentEnv: "main",
    });
  });

  afterAll(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await modelsTestState.cleanup();
  });
}

export { modelPluginMetadataSnapshot };
