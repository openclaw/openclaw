import fs from "node:fs";
import path from "node:path";
import { aroundEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../../config/config.js";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
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
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../plugins/runtime.js";
import type { PluginRuntime } from "../../../../plugins/runtime/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../../../test-utils/openclaw-test-state.js";
import { getChannelPlugin } from "../../registry.js";
import type { ChannelPlugin } from "../../types.public.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId as BindingChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";

const contractApiPromises: Record<string, Promise<Record<string, unknown>>> = {};
const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;
const matrixManagerOptions = {
  accountId: matrixSessionBindingAuth.accountId,
  auth: matrixSessionBindingAuth,
  client: {} as never,
  idleTimeoutMs: 24 * 60 * 60 * 1000,
  maxAgeMs: 0,
  enableSweeper: false,
};

async function getContractApi<T extends Record<string, unknown>>(
  pluginId: string,
  artifact = "session-binding-contract-api",
): Promise<T> {
  const key = `${pluginId}:${artifact}`;
  return (await (contractApiPromises[key] ??= importBundledChannelContractArtifact<T>(
    pluginId,
    artifact,
  ))) as T;
}

function keyedState(pluginId: string) {
  return {
    openKeyedStoreV2: <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority: PluginStateActionAuthority = { assertCurrent() {} },
    ) => createPluginStateKeyedStoreV2ForTests<T>(pluginId, options, authority),
  };
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
const managerConfig = { accountId: "default", cfg: baseSessionBindingCfg };

type BindingManager = { stop: () => void | Promise<void> };
const managers: Partial<Record<BindingChannelId, BindingManager>> = {};

type FeishuContractApi = {
  createFeishuThreadBindingManager: (params: typeof managerConfig) => BindingManager;
};

type MatrixContractApi = {
  createMatrixThreadBindingManager: (
    params: typeof matrixManagerOptions,
  ) => Promise<BindingManager>;
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

async function stopManager(id: BindingChannelId) {
  await managers[id]?.stop();
  delete managers[id];
}

function registerPlugin(pluginId: string, plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId, plugin, source: "test" }]));
}

async function prepareTelegramSessionBindingContract() {
  const telegramPlugin = await getBindingPlugin("telegram");
  const { setTelegramRuntime } = await loadBundledPluginFacade<{
    setTelegramRuntime: (runtime: PluginRuntime) => void;
  }>({ pluginId: "telegram", artifactBasename: "runtime-setter-api.js" });
  registerPlugin("telegram", telegramPlugin);
  setTelegramRuntime(createPluginRuntimeMock({ state: keyedState("telegram") }));
}

type SessionBindingContractFixture = {
  id: BindingChannelId;
  accountId?: string;
  conversationId: string;
  parentConversationId?: string;
  expectedBindingId?: string;
  targetKind?: SessionBindingRecord["targetKind"];
  metadata?: Record<string, unknown>;
  placements: SessionBindingCapabilities["placements"];
};

async function prepareBindingContract(id: BindingChannelId) {
  await stopManager(id);
  if (id === "matrix") {
    resetPluginStateStoreForTests();
    fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
    fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
  } else if (id === "telegram") {
    await prepareTelegramSessionBindingContract();
  } else if (id !== "feishu") {
    registerPlugin(id, await getBindingPlugin(id));
  }
}

async function ensureBindingContractManager(id: BindingChannelId) {
  if (managers[id]) {
    return;
  }
  if (id === "matrix") {
    const { setMatrixRuntime, createMatrixThreadBindingManager } =
      await getContractApi<MatrixContractApi>("matrix");
    setMatrixRuntime({
      state: {
        ...keyedState("matrix"),
        resolveStateDir: () => matrixSessionBindingStateDir,
      },
    });
    managers.matrix = await createMatrixThreadBindingManager(matrixManagerOptions);
  } else if (id === "feishu") {
    const { createFeishuThreadBindingManager } = await getContractApi<FeishuContractApi>(id);
    managers.feishu = createFeishuThreadBindingManager(managerConfig);
  } else {
    const manager =
      await getChannelPlugin(id)?.conversationBindings?.createManager?.(managerConfig);
    if (!manager) {
      throw new Error(`${id} session binding manager is unavailable`);
    }
    managers[id] = manager;
  }
}

const fixtures = {
  discord: {
    conversationId: "channel:123456789012345678",
    placements: ["current", "child"],
  },
  feishu: {
    conversationId: "oc_group_chat:topic:om_topic_root",
    parentConversationId: "oc_group_chat",
    placements: ["current"],
  },
  imessage: {
    conversationId: "+15555550124",
    expectedBindingId: "default:+15555550124",
    targetKind: "session",
    metadata: { opaque: { ownerEpoch: 7, capabilities: ["approve", "resume"] } },
    placements: ["current"],
  },
  matrix: {
    accountId: matrixSessionBindingAuth.accountId,
    conversationId: "$thread",
    parentConversationId: "!room:example.org",
    placements: ["current", "child"],
  },
  telegram: {
    conversationId: "-100200300:topic:77",
    placements: ["current", "child"],
  },
} satisfies Record<BindingChannelId, Omit<SessionBindingContractFixture, "id">>;

export function getSessionBindingContractRegistry(): SessionBindingContractFixture[] {
  return sessionBindingContractChannelIds.map((id) => Object.assign({ id }, fixtures[id]));
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const fixture = getSessionBindingContractRegistry().find((entry) => entry.id === id);
  if (!fixture) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }
  const targetSessionKey = "agent:contract:binding";
  const conversation = {
    channel: fixture.id,
    accountId: fixture.accountId ?? "default",
    conversationId: fixture.conversationId,
    ...(fixture.parentConversationId ? { parentConversationId: fixture.parentConversationId } : {}),
  };
  const service = getSessionBindingService();
  const expectResolved = (metadata?: Record<string, unknown>) =>
    expect(service.resolveByConversation(conversation)).toMatchObject({
      targetSessionKey,
      ...(metadata ? { metadata } : {}),
    });

  describe(`${fixture.id} session binding contract`, () => {
    beforeAll(() =>
      fixture.id === "matrix" || fixture.id === "feishu"
        ? getContractApi(fixture.id)
        : getBindingPlugin(fixture.id),
    );
    aroundEach(async (run) => {
      const testState = await createOpenClawTestState({
        label: `${id}-session-binding-contract`,
        layout: "state-only",
      });
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      // Enable config-aware facades without inheriting the host configuration.
      setRuntimeConfigSnapshot(
        id === "discord" || id === "matrix"
          ? { plugins: { entries: { [id]: { enabled: true } } } }
          : {},
      );
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      try {
        await prepareBindingContract(fixture.id);
        await run();
      } finally {
        clearRuntimeConfigSnapshot();
        await testState.cleanup();
      }
    });
    it("registers, binds, unbinds, and cleans up session bindings", async () => {
      await ensureBindingContractManager(fixture.id);
      expect(
        service.getCapabilities({ channel: fixture.id, accountId: conversation.accountId }),
      ).toEqual({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: true,
        placements: fixture.placements,
      });
      try {
        const binding = await service.bind({
          targetSessionKey,
          targetKind: fixture.targetKind ?? "subagent",
          conversation,
          placement: "current",
          metadata: { agentId: fixture.id, label: "contract-binding", ...fixture.metadata },
        });
        if (fixture.expectedBindingId) {
          expect(binding.bindingId).toBe(fixture.expectedBindingId);
        }
        if (fixture.metadata) {
          expect(binding.metadata).toMatchObject(fixture.metadata);
        }
        expectResolved();
        if (fixture.id === "imessage") {
          await stopManager(fixture.id);
          closeOpenClawStateDatabaseForTest();
          await ensureBindingContractManager(fixture.id);
          expectResolved(fixture.metadata);
        }
        expect(binding.targetSessionKey).toBe(targetSessionKey);
        expect(typeof binding.bindingId).toBe("string");
        expect(binding.bindingId.trim()).not.toBe("");
        for (const value of [
          binding.conversation.channel,
          binding.conversation.accountId,
          binding.conversation.conversationId,
        ]) {
          expect(typeof value).toBe("string");
        }
        expect(typeof binding.boundAt).toBe("number");
        expect(["session", "subagent"]).toContain(binding.targetKind);
        expect(["active", "ending", "ended"]).toContain(binding.status);
        const removed = await service.unbind({
          bindingId: binding.bindingId,
          reason: "contract-test",
        });
        expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
        expect(service.resolveByConversation(binding.conversation)).toBeNull();
      } finally {
        await stopManager(fixture.id);
        const { channel, accountId, conversationId } = conversation;
        expect(service.resolveByConversation({ channel, accountId, conversationId })).toBeNull();
      }
    });
  });
}
