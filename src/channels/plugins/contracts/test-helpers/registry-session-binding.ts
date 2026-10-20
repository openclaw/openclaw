import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../../infra/outbound/session-binding-service.js";
import type { SessionBindingCapabilities } from "../../../../infra/outbound/session-binding.types.js";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "../../../../plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "../../../../plugin-sdk/plugin-state-test-runtime.js";
import { createPluginRuntimeMock } from "../../../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { setActivePluginRegistry } from "../../../../plugins/runtime.js";
import type { PluginRuntime } from "../../../../plugins/runtime/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../../test-utils/channel-plugins.js";
import { getChannelPlugin } from "../../registry.js";
import type { ChannelPlugin } from "../../types.public.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  preload?: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
};
const contractApiPromises = new Map<string, Promise<Record<string, unknown>>>();

const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;

async function getContractApi<T extends Record<string, unknown>>(
  pluginId: string,
  artifact = "session-binding-contract-api",
): Promise<T> {
  const cacheKey = `${pluginId}:${artifact}`;
  const existing = contractApiPromises.get(cacheKey);
  if (existing) {
    return (await existing) as T;
  }
  const next = importBundledChannelContractArtifact<T>(pluginId, artifact);
  contractApiPromises.set(cacheKey, next);
  return await next;
}

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  metadata?: Record<string, unknown>;
}) {
  const { targetSessionKey, metadata, ...conversation } = params;
  expect(getSessionBindingService().resolveByConversation(conversation))?.toMatchObject({
    targetSessionKey,
    ...(metadata ? { metadata } : {}),
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function resetMatrixSessionBindingStateDir() {
  resetPluginStateStoreForTests();
  fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
  fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
}

async function createContractMatrixThreadBindingManager() {
  if (managers.matrix) {
    return managers.matrix;
  }
  const { setMatrixRuntime, createMatrixThreadBindingManager } =
    await getContractApi<MatrixContractApi>("matrix");
  setMatrixRuntime({
    state: {
      openKeyedStoreV2: (
        options: OpenAsyncKeyedStoreOptions,
        authority: PluginStateActionAuthority = { assertCurrent() {} },
      ) => createPluginStateKeyedStoreV2ForTests("matrix", options, authority),
      resolveStateDir: () => matrixSessionBindingStateDir,
    },
  });
  const manager = await createMatrixThreadBindingManager({
    accountId: matrixSessionBindingAuth.accountId,
    auth: matrixSessionBindingAuth,
    client: {} as never,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  });
  managers.matrix = manager;
  return manager;
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type ChannelConversationBindingManagerFactory = NonNullable<
  NonNullable<ChannelPlugin["conversationBindings"]>["createManager"]
>;
type ChannelConversationBindingManager = Awaited<
  ReturnType<ChannelConversationBindingManagerFactory>
>;
const managers: Partial<
  Record<SessionBindingContractChannelId, ChannelConversationBindingManager>
> = {};

type FeishuContractApi = {
  createFeishuThreadBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => ChannelConversationBindingManager;
};

type MatrixContractApi = {
  createMatrixThreadBindingManager: (params: {
    accountId: string;
    auth: typeof matrixSessionBindingAuth;
    client: unknown;
    idleTimeoutMs: number;
    maxAgeMs: number;
    enableSweeper: boolean;
  }) => Promise<ChannelConversationBindingManager>;
  setMatrixRuntime: (runtime: unknown) => void;
};

async function getBindingPlugin<Id extends "discord" | "imessage" | "telegram">(id: Id) {
  type Api = Record<`${Id}Plugin`, ChannelPlugin>;
  const api =
    id === "telegram"
      ? await loadBundledPluginFacade<Api>({
          pluginId: id,
          artifactBasename: "channel-plugin-api.js",
        })
      : await getContractApi<Api>(id, "channel-plugin-api");
  const key: `${Id}Plugin` = `${id}Plugin`;
  return api[key];
}

async function stopManager(id: SessionBindingContractChannelId) {
  await managers[id]?.stop();
  delete managers[id];
}

function registerPlugin(pluginId: string, plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId, plugin, source: "test" }]));
}

async function ensureManager(id: "discord" | "imessage" | "telegram") {
  if (managers[id]) {
    return;
  }
  const createManager = getChannelPlugin(id)?.conversationBindings?.createManager;
  const manager = await createManager?.({ cfg: baseSessionBindingCfg, accountId: "default" });
  if (!manager) {
    throw new Error(`${id} session binding manager is unavailable`);
  }
  managers[id] = manager;
}

async function prepareMatrixSessionBindingContract() {
  resetMatrixSessionBindingStateDir();
}

async function prepareTelegramSessionBindingContract() {
  const telegramPlugin = await getBindingPlugin("telegram");
  const { setTelegramRuntime } = await loadBundledPluginFacade<{
    setTelegramRuntime: (runtime: PluginRuntime) => void;
  }>({ pluginId: "telegram", artifactBasename: "runtime-setter-api.js" });
  registerPlugin("telegram", telegramPlugin);
  setTelegramRuntime(
    createPluginRuntimeMock({
      state: {
        openKeyedStoreV2: <T>(
          options: OpenAsyncKeyedStoreOptions,
          authority: PluginStateActionAuthority = { assertCurrent() {} },
        ) => createPluginStateKeyedStoreV2ForTests<T>("telegram", options, authority),
      },
    }),
  );
}

type SessionBindingContractFixture = {
  id: SessionBindingContractChannelId;
  accountId?: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  expectedBindingId?: string;
  targetKind?: SessionBindingRecord["targetKind"];
  label: string;
  metadata?: Record<string, unknown>;
  placements: SessionBindingCapabilities["placements"];
  preload: () => Promise<unknown>;
  beforeEach?: () => Promise<void>;
  ensureManager: () => Promise<void>;
  restartBindingManager?: () => Promise<void>;
};

function createSessionBindingContractEntry(
  fixture: SessionBindingContractFixture,
): Omit<SessionBindingContractEntry, "id"> {
  const conversation = {
    channel: fixture.id,
    accountId: fixture.accountId ?? "default",
    conversationId: fixture.conversationId,
    ...(fixture.parentConversationId ? { parentConversationId: fixture.parentConversationId } : {}),
  };

  return {
    preload: async () => {
      await fixture.preload();
    },
    beforeEach: async () => {
      await stopManager(fixture.id);
      await fixture.beforeEach?.();
    },
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: fixture.placements,
    },
    getCapabilities: async () => {
      await fixture.ensureManager();
      return getSessionBindingService().getCapabilities({
        channel: fixture.id,
        accountId: conversation.accountId,
      });
    },
    bindAndResolve: async () => {
      await fixture.ensureManager();
      const binding = await getSessionBindingService().bind({
        targetSessionKey: fixture.targetSessionKey,
        targetKind: fixture.targetKind ?? "subagent",
        conversation,
        placement: "current",
        metadata: { agentId: fixture.id, label: fixture.label, ...fixture.metadata },
      });
      if (fixture.expectedBindingId) {
        expect(binding.bindingId).toBe(fixture.expectedBindingId);
      }
      if (fixture.metadata) {
        expect(binding.metadata).toMatchObject(fixture.metadata);
      }
      expectResolvedSessionBinding({
        ...conversation,
        targetSessionKey: fixture.targetSessionKey,
      });
      if (fixture.restartBindingManager) {
        await fixture.restartBindingManager();
        expectResolvedSessionBinding({
          ...conversation,
          targetSessionKey: fixture.targetSessionKey,
          metadata: fixture.metadata,
        });
      }
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      await stopManager(fixture.id);
      const { channel, accountId, conversationId } = conversation;
      expect(
        getSessionBindingService().resolveByConversation({ channel, accountId, conversationId }),
      ).toBeNull();
    },
  };
}

const sessionBindingContractEntries = {
  discord: createSessionBindingContractEntry({
    id: "discord",
    conversationId: "channel:123456789012345678",
    targetSessionKey: "agent:discord:child:thread-1",
    label: "discord-child",
    placements: ["current", "child"],
    preload: () => getBindingPlugin("discord"),
    beforeEach: async () => {
      registerPlugin("discord", await getBindingPlugin("discord"));
    },
    ensureManager: () => ensureManager("discord"),
  }),
  feishu: createSessionBindingContractEntry({
    id: "feishu",
    conversationId: "oc_group_chat:topic:om_topic_root",
    parentConversationId: "oc_group_chat",
    targetSessionKey: "agent:feishu:child:thread-1",
    label: "feishu-child",
    placements: ["current"],
    preload: () => getContractApi<FeishuContractApi>("feishu"),
    ensureManager: async () => {
      const { createFeishuThreadBindingManager } =
        await getContractApi<FeishuContractApi>("feishu");
      managers.feishu ??= createFeishuThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
      });
    },
  }),
  imessage: createSessionBindingContractEntry({
    id: "imessage",
    conversationId: "+15555550124",
    targetSessionKey: "agent:imessage:current",
    expectedBindingId: "default:+15555550124",
    targetKind: "session",
    label: "imessage-main",
    metadata: { opaque: { ownerEpoch: 7, capabilities: ["approve", "resume"] } },
    placements: ["current"],
    preload: () => getBindingPlugin("imessage"),
    beforeEach: async () => {
      registerPlugin("imessage", await getBindingPlugin("imessage"));
    },
    ensureManager: () => ensureManager("imessage"),
    restartBindingManager: async () => {
      await stopManager("imessage");
      closeOpenClawStateDatabaseForTest();
      await ensureManager("imessage");
    },
  }),
  matrix: createSessionBindingContractEntry({
    id: "matrix",
    accountId: matrixSessionBindingAuth.accountId,
    conversationId: "$thread",
    parentConversationId: "!room:example.org",
    targetSessionKey: "agent:matrix:thread",
    label: "matrix-thread",
    placements: ["current", "child"],
    preload: () => getContractApi<MatrixContractApi>("matrix"),
    beforeEach: prepareMatrixSessionBindingContract,
    ensureManager: async () => {
      await createContractMatrixThreadBindingManager();
    },
  }),
  telegram: createSessionBindingContractEntry({
    id: "telegram",
    conversationId: "-100200300:topic:77",
    targetSessionKey: "agent:telegram:child:thread-1",
    label: "telegram-topic",
    placements: ["current", "child"],
    preload: () => getBindingPlugin("telegram"),
    beforeEach: prepareTelegramSessionBindingContract,
    ensureManager: () => ensureManager("telegram"),
  }),
} satisfies Record<SessionBindingContractChannelId, Omit<SessionBindingContractEntry, "id">>;

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) =>
    Object.assign({ id }, sessionBindingContractEntries[id]),
  );
  return sessionBindingContractRegistryCache;
}
