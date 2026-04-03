import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { createChannelConversationBindingManager } from "../conversation-bindings.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import "./registry.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
};
let discordRuntimeApiPromise:
  | Promise<typeof import("../../../../extensions/discord/runtime-api.js")>
  | undefined;
let feishuApiPromise: Promise<typeof import("../../../../extensions/feishu/api.js")> | undefined;
let matrixApiPromise: Promise<typeof import("../../../../extensions/matrix/api.js")> | undefined;
let matrixRuntimeApiPromise:
  | Promise<typeof import("../../../../extensions/matrix/runtime-api.js")>
  | undefined;

const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;

async function getDiscordRuntimeApi() {
  discordRuntimeApiPromise ??= import("../../../../extensions/discord/runtime-api.js");
  return await discordRuntimeApiPromise;
}

async function getFeishuApi() {
  feishuApiPromise ??= import("../../../../extensions/feishu/api.js");
  return await feishuApiPromise;
}

async function getMatrixApi() {
  matrixApiPromise ??= import("../../../../extensions/matrix/api.js");
  return await matrixApiPromise;
}

async function getMatrixRuntimeApi() {
  matrixRuntimeApiPromise ??= import("../../../../extensions/matrix/runtime-api.js");
  return await matrixRuntimeApiPromise;
}

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
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

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

function resetMatrixSessionBindingStateDir() {
  fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
  fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
}

async function createContractMatrixThreadBindingManager() {
  resetMatrixSessionBindingStateDir();
  const { setMatrixRuntime } = await getMatrixRuntimeApi();
  const { createMatrixThreadBindingManager } = await getMatrixApi();
  setMatrixRuntime({
    state: {
      resolveStateDir: () => matrixSessionBindingStateDir,
    },
  } as never);
  return await createMatrixThreadBindingManager({
    accountId: matrixSessionBindingAuth.accountId,
    auth: matrixSessionBindingAuth,
    client: {} as never,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  });
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

const sessionBindingContractEntries: Record<
  SessionBindingContractChannelId,
  Omit<SessionBindingContractEntry, "id">
> = {
  bluebubbles: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "bluebubbles",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "bluebubbles",
          accountId: "default",
          conversationId: "+15555550123",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
      });
    },
  },
  discord: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "discord",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:discord:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:123456789012345678",
        },
        placement: "current",
        metadata: {
          label: "codex-discord",
        },
      });
      expectResolvedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
        targetSessionKey: "agent:discord:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
      });
    },
  },
  feishu: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      return getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
          parentConversationId: "oc_group_chat",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      const manager = createFeishuThreadBindingManager({
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      });
    },
  },
  imessage: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "imessage",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:imessage:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "imessage",
          accountId: "default",
          conversationId: "+15555550123",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
        targetSessionKey: "agent:codex:acp:binding:imessage:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
      });
    },
  },
  matrix: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      await createContractMatrixThreadBindingManager();
      return getSessionBindingService().getCapabilities({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
      });
    },
    bindAndResolve: async () => {
      await createContractMatrixThreadBindingManager();
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:matrix:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: matrixSessionBindingAuth.accountId,
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
        metadata: {
          label: "codex-matrix",
        },
      });
      expectResolvedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
        targetSessionKey: "agent:matrix:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { resetMatrixThreadBindingsForTests } = await getMatrixApi();
      resetMatrixThreadBindingsForTests();
      resetMatrixSessionBindingStateDir();
      expectClearedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
      });
    },
  },
  telegram: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "current",
        metadata: {
          boundBy: "user-1",
        },
      });
      expectResolvedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
        targetSessionKey: "agent:main:subagent:child-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      });
    },
  },
};

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) => ({
    id,
    ...sessionBindingContractEntries[id],
  }));
  return sessionBindingContractRegistryCache;
}
