import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as config from "../../../../config/config.js";
import * as sessionBinding from "../../../../infra/outbound/session-binding-service.js";
import type { SessionBindingCapabilities } from "../../../../infra/outbound/session-binding.types.js";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "../../../../plugin-sdk/plugin-state-runtime.js";
import * as pluginState from "../../../../plugin-sdk/plugin-state-test-runtime.js";
import { createPluginRuntimeMock } from "../../../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import * as pluginRuntime from "../../../../plugins/runtime.js";
import type { PluginRuntime } from "../../../../plugins/runtime/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../../../test-utils/openclaw-test-state.js";
import { getChannelPlugin } from "../../registry.js";
import type { ChannelPlugin } from "../../types.public.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId as BindingChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";
import { expectContractFields } from "./threading-directory-contract-suites.js";

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

function getContractApi<T extends Record<string, unknown>>(
  pluginId: string,
  artifact = "session-binding-contract-api",
): Promise<T> {
  return importBundledChannelContractArtifact<T>(pluginId, artifact);
}

function keyedState(pluginId: string) {
  return {
    openKeyedStoreV2: <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority: PluginStateActionAuthority = { assertCurrent() {} },
    ) => pluginState.createPluginStateKeyedStoreV2ForTests<T>(pluginId, options, authority),
  };
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies config.OpenClawConfig;
const managerConfig = { accountId: "default", cfg: baseSessionBindingCfg };

type BindingManager = { stop: () => void | Promise<void> };

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

type SessionBindingContractFixture = {
  id: BindingChannelId;
  accountId?: string;
  conversationId: string;
  parentConversationId?: string;
  expectedBindingId?: string;
  targetKind?: sessionBinding.SessionBindingRecord["targetKind"];
  metadata?: Record<string, unknown>;
  placements: SessionBindingCapabilities["placements"];
};

async function createBindingContractManager(id: BindingChannelId): Promise<BindingManager> {
  if (id === "matrix") {
    const { setMatrixRuntime, createMatrixThreadBindingManager } =
      await getContractApi<MatrixContractApi>("matrix");
    setMatrixRuntime({
      state: {
        ...keyedState("matrix"),
        resolveStateDir: () => matrixSessionBindingStateDir,
      },
    });
    return createMatrixThreadBindingManager(matrixManagerOptions);
  }
  if (id === "feishu") {
    const { createFeishuThreadBindingManager } = await getContractApi<FeishuContractApi>(id);
    return createFeishuThreadBindingManager(managerConfig);
  }
  const plugin = await getBindingPlugin(id);
  pluginRuntime.setActivePluginRegistry(
    createTestRegistry([{ pluginId: id, plugin, source: "test" }]),
  );
  if (id === "telegram") {
    const { setTelegramRuntime } = await loadBundledPluginFacade<{
      setTelegramRuntime: (runtime: PluginRuntime) => void;
    }>({ pluginId: id, artifactBasename: "runtime-setter-api.js" });
    setTelegramRuntime(createPluginRuntimeMock({ state: keyedState(id) }));
  }
  const manager = await getChannelPlugin(id)?.conversationBindings?.createManager?.(managerConfig);
  if (!manager) {
    throw new Error(`${id} session binding manager is unavailable`);
  }
  return manager;
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
  const service = sessionBinding.getSessionBindingService();
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
    it("registers, binds, unbinds, and cleans up session bindings", () =>
      withOpenClawTestState(
        { label: `${id}-session-binding-contract`, layout: "state-only" },
        async () => {
          pluginRuntime.resetPluginRuntimeStateForTest();
          config.clearRuntimeConfigSnapshot();
          // Enable config-aware facades without inheriting the host configuration.
          config.setRuntimeConfigSnapshot(
            id === "discord" || id === "matrix"
              ? { plugins: { entries: { [id]: { enabled: true } } } }
              : {},
          );
          sessionBinding.testing.resetSessionBindingAdaptersForTests();
          let manager: BindingManager | undefined;
          try {
            if (fixture.id === "matrix") {
              pluginState.resetPluginStateStoreForTests();
              fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
              fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
            }
            manager = await createBindingContractManager(fixture.id);
            expect(
              service.getCapabilities({ channel: fixture.id, accountId: conversation.accountId }),
            ).toEqual({
              adapterAvailable: true,
              bindSupported: true,
              unbindSupported: true,
              placements: fixture.placements,
            });
            const binding = await service.bind({
              targetSessionKey,
              targetKind: fixture.targetKind ?? "subagent",
              conversation,
              placement: "current",
              metadata: { agentId: fixture.id, label: "contract-binding", ...fixture.metadata },
            });
            if (fixture.metadata) {
              expect(binding.metadata).toMatchObject(fixture.metadata);
            }
            expectResolved();
            if (fixture.id === "imessage") {
              await manager.stop();
              closeOpenClawStateDatabaseForTest();
              manager = await createBindingContractManager(fixture.id);
              expectResolved(fixture.metadata);
            }
            expectContractFields(binding, {
              targetSessionKey: (value) => value === targetSessionKey,
              bindingId: (value) =>
                typeof value === "string" &&
                value.trim() !== "" &&
                (!fixture.expectedBindingId || value === fixture.expectedBindingId),
              boundAt: (value) => typeof value === "number",
              targetKind: (value) => value === "session" || value === "subagent",
              status: (value) => value === "active" || value === "ending" || value === "ended",
            });
            for (const key of ["channel", "accountId", "conversationId"] as const) {
              expect(typeof binding.conversation[key]).toBe("string");
            }
            const removed = await service.unbind({
              bindingId: binding.bindingId,
              reason: "contract-test",
            });
            expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
            expect(service.resolveByConversation(binding.conversation)).toBeNull();
          } finally {
            try {
              await manager?.stop();
              const { channel, accountId, conversationId } = conversation;
              expect(
                service.resolveByConversation({ channel, accountId, conversationId }),
              ).toBeNull();
            } finally {
              config.clearRuntimeConfigSnapshot();
            }
          }
        },
      ));
  });
}
