import { randomUUID } from "node:crypto";
import { onTestFinished, vi } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  resolveUsableAgentCredentialModes,
  type AgentCredentialMap,
} from "../../agents/agent-auth-credentials.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import * as auth from "../../agents/auth-profiles.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../../agents/auth-profiles/path-resolve.native.js";
import * as authRevisionRuntime from "../../agents/auth-profiles/runtime-snapshots.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolvePublishedModelCatalogOwner } from "../../agents/prepared-model-catalog-owner.js";
import * as catalogRuntime from "../../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as pluginRuntime from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as skills from "../../skills/runtime/refresh-state.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { createGatewayChatMetadataRuntime } from "./chat-metadata-runtime.js";
import * as projectionRuntime from "./chat-metadata-session-projection.js";
import type { ChatMetadataProjectionFacts } from "./chat-metadata-session-projection.js";
import * as commands from "./commands-list-result.js";
import * as modelLists from "./models-list-result.js";

export const chatMetadataCommandFields = {
  description: "",
  source: "native" as const,
  scope: "text" as const,
  acceptsArgs: false,
};

export function connectChatMetadataAccount(profileId: string): string {
  return connectUserModelAccount({
    ownerProfileId: profileId,
    credential: {
      type: "oauth",
      provider: "openai",
      displayName: "Private provider account",
      access: "synthetic-personal-access",
      refresh: "synthetic-personal-refresh",
      expires: Date.now() + 600_000,
    },
    assertCurrent() {},
  }).authProfileId;
}

export async function createPersonalChatMetadataFixture() {
  const config = createOpenAIChatMetadataConfig();
  delete config.agents?.defaults?.models;
  const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
  const owner = createChatMetadataOwner(
    config,
    "gpt-5.6-luna",
    {},
    "openai",
    "openai-chatgpt-responses",
  );
  harness.setOwner(owner);
  await harness.runtime.refresh();
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  setDisplayName(alice.id, "Alice");
  return {
    harness,
    owner,
    alice,
    bob,
    aliceScope: { agentId: "main", requesterProfileId: alice.id },
    bobScope: { agentId: "main", requesterProfileId: bob.id },
  };
}

export function createDraftChatMetadataScope(
  owner: string = randomUUID(),
  authProfileId = `personal:${owner}:${randomUUID()}`,
) {
  const error = new ModelAccountConnectAuthorityError();
  let current = true;
  return {
    params: {
      agentId: "main",
      requesterProfileId: owner,
      draftAccountSelection: {
        owner,
        authProfileId,
        assertCurrent() {
          if (!current) {
            throw error;
          }
        },
      },
    },
    close() {
      current = false;
    },
    error,
  };
}

export function createOpenAIChatMetadataConfig(modelIds = ["gpt-5.6-luna"]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna" },
        models: Object.fromEntries(modelIds.map((id) => [`openai/${id}`, {}])),
      },
      entries: { main: {} },
    },
  };
}

export function createChatMetadataOwner(
  config: OpenClawConfig,
  id: string,
  credentials: AgentCredentialMap = {},
  provider = "test",
  api?: ModelCatalogEntry["api"],
): PreparedModelRuntimeSnapshot {
  prepareSharedAuthStoreOwnershipForNative();
  const model = { id, name: id, provider, ...(api ? { api } : {}) };
  const authStore: AuthProfileStore = {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(credentials).map(([credentialProvider, credential]) => [
        `${credentialProvider}:prepared`,
        { ...credential, provider: credentialProvider },
      ]),
    ),
  };
  const owner: PreparedModelRuntimeSnapshot = {
    catalogOwner: { agentId: "main", workspaceDir: `/tmp/${id}/workspace` },
    agentId: "main",
    agentDir: `/tmp/${id}/agent`,
    workspaceDir: `/tmp/${id}/workspace`,
    activeProjectKeys: [],
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: resolveUsableAgentCredentialModes(credentials),
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [model], routeVariants: api ? [model] : [] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores() {
      throw new Error("Chat metadata must not create executable model stores");
    },
  };
  bindPreparedModelRuntimeAuth(owner, { store: authStore });
  return owner;
}

export function createChatMetadataHarness(
  initialConfig: OpenClawConfig = { agents: { entries: { main: {} } } },
  runtimeOptions: {
    useDefaultProjection?: boolean;
    onChanged?: () => void;
  } = {},
) {
  const { useDefaultProjection = false, ...gatewayRuntimeOptions } = runtimeOptions;
  let config = initialConfig;
  let owner = createChatMetadataOwner(config, "first");
  let skillsVersion = 1;
  let authStore: AuthProfileStore | undefined = { version: 1, profiles: {} };
  let authStoreRevision = 1;
  const invalidProjections = new WeakSet<object>();
  const deps = {
    getPreparedAuthStore: vi
      .spyOn(auth, "getPreparedRuntimeAuthProfileStoreSnapshot")
      .mockImplementation(() => authStore),
    getSkillsVersion: vi
      .spyOn(skills, "getSkillsSnapshotVersion")
      .mockImplementation(() => skillsVersion),
    getPluginRegistryVersion: vi.spyOn(pluginRuntime, "getActivePluginRegistryVersion").mockClear(),
    getPreparedOwner: vi
      .spyOn(catalogRuntime, "getPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(() => owner),
    getAuthStoreRevision: vi
      .spyOn(authRevisionRuntime, "getRuntimeAuthProfileStoreMetadataRevision")
      .mockImplementation(() => authStoreRevision),
    buildCommands: vi.spyOn(commands, "buildCommandsListResult").mockImplementation(async () => ({
      commands: [{ ...chatMetadataCommandFields, name: `command-${skillsVersion}-1` }],
    })),
  };
  onTestFinished(() => {
    for (const spy of Object.values(deps)) {
      spy.mockRestore();
    }
  });
  const buildProjection = vi.fn(async ({ facts }: { facts: ChatMetadataProjectionFacts }) => ({
    modelCatalog: facts.modelCatalog.entries,
    models: facts.modelCatalog.entries,
  }));
  const readProjection = vi.fn(
    (projection: { modelCatalog: ModelCatalogEntry[]; models?: ModelChoice[] }) => projection,
  );
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: async (params?: { readOnly?: boolean }) => {
      const modelCatalog =
        params?.readOnly === false && owner.loadFullModelCatalog
          ? await owner.loadFullModelCatalog()
          : owner.modelCatalog;
      const resolved = resolvePublishedModelCatalogOwner(owner);
      return {
        ...modelCatalog,
        agentId: resolved.agentId,
        agentDir: resolved.agentDir,
        workspaceDir: resolved.workspaceDir,
        config: resolved.config,
        catalogComplete: isPreparedModelCatalogFull(modelCatalog),
      };
    },
    logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  if (!useDefaultProjection) {
    const projectionSpy = vi
      .spyOn(projectionRuntime, "prepareChatMetadataModelProjection")
      .mockImplementation(async (params) => {
        const projection = await buildProjection(params);
        return {
          modelCatalog: projection.modelCatalog,
          read: () => ({ models: readProjection(projection).models }),
          isCurrent: () => !invalidProjections.has(projection),
        };
      });
    onTestFinished(() => projectionSpy.mockRestore());
  }
  const runtime = createGatewayChatMetadataRuntime({
    getConfig: () => config,
    getContext: () => context,
    log: context.logGateway,
    ...gatewayRuntimeOptions,
  });
  return {
    ...deps,
    buildProjection,
    readProjection,
    invalidProjections,
    runtime,
    read: (params: Partial<Parameters<typeof runtime.read>[0]> = {}) =>
      runtime.read({ agentId: "main", ...params }),
    startup: (params: Partial<Parameters<typeof runtime.readStartup>[0]> = {}) =>
      runtime.readStartup({ agentId: "main", ...params }),
    refresh: runtime.refresh,
    setConfig(next: OpenClawConfig) {
      config = next;
    },
    setAuthStore(next: AuthProfileStore | undefined) {
      authStore = next;
    },
    setAuthStoreRevision(next: number) {
      authStoreRevision = next;
    },
    setOwner(next: PreparedModelRuntimeSnapshot) {
      owner = next;
    },
    setSkillsVersion(next: number) {
      skillsVersion = next;
    },
  };
}

export function createOtherAgentChatMetadataFixture(signal: AbortSignal) {
  const config = {
    agents: {
      entries: { main: {}, other: {} },
      defaults: { model: "test/main-model", modelPolicy: { allow: ["test/*"] } },
    },
  };
  const pluginRegistry = createEmptyPluginRegistry();
  const owner = (id: string) => ({
    ...createChatMetadataOwner(config, id, {}, "test", "openai-completions"),
    pluginRegistry,
  });
  const mainOwner = owner("main-model");
  let otherOwner = owner("other-model");
  const harness = createChatMetadataHarness(config);
  harness.setOwner(mainOwner);
  harness.getPreparedOwner.mockImplementation((params) =>
    params?.agentId === "other" ? otherOwner : mainOwner,
  );
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const abort = () => release.resolve();
  signal.addEventListener("abort", abort, { once: true });
  let blockOther = false;
  const prepare = modelLists.prepareModelsListResult;
  const preparation = vi
    .spyOn(modelLists, "prepareModelsListResult")
    .mockImplementation(async (params) => {
      if (blockOther && params.agentId === "other") {
        entered.resolve();
        await release.promise;
      }
      return prepare(params);
    });
  const pending: Promise<unknown>[] = [];
  return {
    config,
    harness,
    entered,
    release,
    pending,
    request: {
      agentId: "other",
      params: { agentId: "other", view: "all" as const },
      includeManualSelection: true,
    },
    holdOtherModel(id: string) {
      otherOwner = owner(id);
      blockOther = true;
    },
    async stop() {
      release.resolve();
      await Promise.allSettled(pending);
      preparation.mockRestore();
      signal.removeEventListener("abort", abort);
      await harness.runtime.stop();
    },
  };
}
