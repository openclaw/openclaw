import path from "node:path";
import { createJiti } from "jiti";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "./session-binding-service.js";

function createRecord(input: SessionBindingBindInput): SessionBindingRecord {
  const conversationId =
    input.placement === "child"
      ? "thread-created"
      : input.conversation.conversationId.trim() || "thread-current";
  return {
    bindingId: `default:${conversationId}`,
    targetSessionKey: input.targetSessionKey,
    targetKind: input.targetKind,
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId,
      parentConversationId: input.conversation.parentConversationId?.trim() || undefined,
    },
    status: "active",
    boundAt: 1,
  };
}

describe("session binding service", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  it("normalizes conversation refs and infers current placement", async () => {
    const bind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      bind,
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "Discord",
        accountId: "DEFAULT",
        conversationId: " thread-1 ",
      },
    });

    expect(result.conversation.channel).toBe("discord");
    expect(result.conversation.accountId).toBe("default");
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        }),
      }),
    );
  });

  it("supports explicit child placement when adapter advertises it", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: { placements: ["child"] },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:1",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "thread-1",
      },
      placement: "child",
    });

    expect(result.conversation.conversationId).toBe("thread-created");
  });

  it("returns structured errors when adapter is unavailable", async () => {
    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });
  });

  it("returns structured errors for unsupported placement", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: { placements: ["current"] },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const rejected = await getSessionBindingService()
      .bind({
        targetSessionKey: "agent:codex:acp:1",
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        placement: "child",
      })
      .catch((error) => error);

    expect(isSessionBindingError(rejected)).toBe(true);
    expect(rejected).toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
      details: {
        placement: "child",
      },
    });
  });

  it("returns structured errors when adapter bind fails", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      bind: async () => null,
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("reports adapter capabilities for command preflight messaging", () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: {
        placements: ["current", "child"],
      },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => [],
    });

    const known = getSessionBindingService().getCapabilities({
      channel: "discord",
      accountId: "default",
    });
    const unknown = getSessionBindingService().getCapabilities({
      channel: "discord",
      accountId: "other",
    });

    expect(known).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    });
    expect(unknown).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    });
  });

  it("shares adapter registrations across native ESM and Jiti loader paths", () => {
    const serviceModulePath = path.join(
      process.cwd(),
      "src/infra/outbound/session-binding-service.ts",
    );
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    });
    const viaJiti = jiti(serviceModulePath) as typeof import("./session-binding-service.js");

    viaJiti.registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "default",
      capabilities: {
        placements: ["current", "child"],
      },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    expect(
      getSessionBindingService().getCapabilities({ channel: "matrix", accountId: "default" }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: false,
      placements: ["current", "child"],
    });
  });

  it("routes lifecycle updates through the channel/account adapter", async () => {
    const setIdleTimeoutBySession = vi.fn(() => [
      {
        bindingId: "default:thread-1",
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent" as const,
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        status: "active" as const,
        boundAt: 1,
      },
    ]);
    const setMaxAgeBySession = vi.fn(() => [
      {
        bindingId: "default:thread-1",
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent" as const,
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        status: "active" as const,
        boundAt: 1,
      },
    ]);
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
      setIdleTimeoutBySession,
      setMaxAgeBySession,
    });

    const service = getSessionBindingService();
    await service.setIdleTimeoutBySession({
      channel: "discord",
      accountId: "default",
      targetSessionKey: " agent:main:subagent:child-1 ",
      idleTimeoutMs: 3_601_999,
    });
    await service.setMaxAgeBySession({
      channel: "discord",
      accountId: "default",
      targetSessionKey: " agent:main:subagent:child-1 ",
      maxAgeMs: 7_202_999,
    });

    expect(setIdleTimeoutBySession).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 3601999,
    });
    expect(setMaxAgeBySession).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 7202999,
    });
  });
});
