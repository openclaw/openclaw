import { beforeEach, describe, expect } from "vitest";
import {
  __testing as feishuThreadBindingTesting,
  createFeishuThreadBindingManager,
} from "../../../../extensions/feishu/src/thread-bindings.js";
import {
  __testing as telegramThreadBindingTesting,
  createTelegramThreadBindingManager,
} from "../../../../extensions/telegram/src/thread-bindings.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
} from "../../../infra/outbound/session-binding-service.js";
import { installSessionBindingContractSuite } from "./suites.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
  telegramThreadBindingTesting.resetTelegramThreadBindingsForTests();
});

describe("feishu session binding contract", () => {
  installSessionBindingContractSuite({
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
      return getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
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
      expect(
        service.resolveByConversation({
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
        }),
      )?.toMatchObject({
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      });
      return binding;
    },
    cleanup: async () => {
      const manager = createFeishuThreadBindingManager({ cfg: baseCfg, accountId: "default" });
      manager.stop();
      expect(
        getSessionBindingService().resolveByConversation({
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
        }),
      ).toBeNull();
    },
  });
});

describe("telegram session binding contract", () => {
  installSessionBindingContractSuite({
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
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
      expect(
        service.resolveByConversation({
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        }),
      )?.toMatchObject({
        targetSessionKey: "agent:main:subagent:child-1",
      });
      return binding;
    },
    cleanup: async () => {
      const manager = createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      expect(
        getSessionBindingService().resolveByConversation({
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        }),
      ).toBeNull();
    },
  });
});
