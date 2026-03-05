import { beforeEach, describe, expect, it } from "vitest";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import {
  __testing,
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

describe("telegram thread bindings", () => {
  beforeEach(() => {
    __testing.resetTelegramThreadBindingsForTests();
  });

  it("registers a telegram binding adapter and binds current conversations", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
    });
    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-100200300:topic:77",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.channel).toBe("telegram");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("-100200300:topic:77");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(manager.getByConversationId("-100200300:topic:77")?.boundBy).toBe("user-1");
  });

  it("does not support child placement", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
    });
  });

  it("updates lifecycle windows by session key", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "1234",
      },
    });

    const idleUpdated = setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    const maxAgeUpdated = setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });
});
