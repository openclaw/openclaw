import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-binding-"));
const approvalsPath = path.join(tempRoot, "plugin-binding-approvals.json");

const sessionBindingState = vi.hoisted(() => {
  const records = new Map<string, SessionBindingRecord>();
  let nextId = 1;

  function normalizeRef(ref: ConversationRef): ConversationRef {
    return {
      channel: ref.channel.trim().toLowerCase(),
      accountId: ref.accountId.trim() || "default",
      conversationId: ref.conversationId.trim(),
      parentConversationId: ref.parentConversationId?.trim() || undefined,
    };
  }

  function toKey(ref: ConversationRef): string {
    const normalized = normalizeRef(ref);
    return JSON.stringify(normalized);
  }

  return {
    records,
    bind: vi.fn(
      async (input: {
        targetSessionKey: string;
        targetKind: "session" | "subagent";
        conversation: ConversationRef;
        metadata?: Record<string, unknown>;
      }) => {
        const normalized = normalizeRef(input.conversation);
        const record: SessionBindingRecord = {
          bindingId: `binding-${nextId++}`,
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: normalized,
          status: "active",
          boundAt: Date.now(),
          metadata: input.metadata,
        };
        records.set(toKey(normalized), record);
        return record;
      },
    ),
    resolveByConversation: vi.fn((ref: ConversationRef) => {
      return records.get(toKey(ref)) ?? null;
    }),
    touch: vi.fn(),
    unbind: vi.fn(async (input: { bindingId?: string }) => {
      const removed: SessionBindingRecord[] = [];
      for (const [key, record] of records.entries()) {
        if (record.bindingId !== input.bindingId) {
          continue;
        }
        removed.push(record);
        records.delete(key);
      }
      return removed;
    }),
    reset() {
      records.clear();
      nextId = 1;
      this.bind.mockClear();
      this.resolveByConversation.mockClear();
      this.touch.mockClear();
      this.unbind.mockClear();
    },
    setRecord(record: SessionBindingRecord) {
      records.set(toKey(record.conversation), record);
    },
  };
});

vi.mock("../infra/home-dir.js", () => ({
  expandHomePrefix: (value: string) => {
    if (value === "~/.openclaw/plugin-binding-approvals.json") {
      return approvalsPath;
    }
    return value;
  },
}));

const {
  __testing,
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
} = await import("./conversation-binding.js");
const { registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
  await import("../infra/outbound/session-binding-service.js");

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    channel,
    accountId,
    capabilities: {
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
    touch: sessionBindingState.touch,
    unbind: sessionBindingState.unbind,
  };
}

describe("plugin conversation binding approvals", () => {
  beforeEach(() => {
    sessionBindingState.reset();
    __testing.reset();
    fs.rmSync(approvalsPath, { force: true });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "default" });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "work" });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "isolated" });
    unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default" });
    registerSessionBindingAdapter(createAdapter("discord", "default"));
    registerSessionBindingAdapter(createAdapter("discord", "work"));
    registerSessionBindingAdapter(createAdapter("discord", "isolated"));
    registerSessionBindingAdapter(createAdapter("telegram", "default"));
  });

  it("requires a fresh approval again after allow-once is consumed", async () => {
    const firstRequest = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    expect(firstRequest.status).toBe("pending");
    if (firstRequest.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    const approved = await resolvePluginConversationBindingApproval({
      approvalId: firstRequest.approvalId,
      decision: "allow-once",
      senderId: "user-1",
    });

    expect(approved.status).toBe("approved");

    const secondRequest = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:2",
      },
      binding: { summary: "Bind this conversation to Codex thread 456." },
    });

    expect(secondRequest.status).toBe("pending");
  });

  it("persists always-allow by plugin root plus channel/account only", async () => {
    const firstRequest = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    expect(firstRequest.status).toBe("pending");
    if (firstRequest.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    const approved = await resolvePluginConversationBindingApproval({
      approvalId: firstRequest.approvalId,
      decision: "allow-always",
      senderId: "user-1",
    });

    expect(approved.status).toBe("approved");

    const sameScope = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:2",
      },
      binding: { summary: "Bind this conversation to Codex thread 456." },
    });

    expect(sameScope.status).toBe("bound");

    const differentAccount = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "work",
        conversationId: "channel:3",
      },
      binding: { summary: "Bind this conversation to Codex thread 789." },
    });

    expect(differentAccount.status).toBe("pending");
  });

  it("does not share persistent approvals across plugin roots even with the same plugin id", async () => {
    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: "77",
      },
      binding: { summary: "Bind this conversation to Codex thread abc." },
    });

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-always",
      senderId: "user-1",
    });

    const samePluginNewPath = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-b",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:78",
        parentConversationId: "-10099",
        threadId: "78",
      },
      binding: { summary: "Bind this conversation to Codex thread def." },
    });

    expect(samePluginNewPath.status).toBe("pending");
  });

  it("returns and detaches only bindings owned by the requesting plugin root", async () => {
    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    expect(["pending", "bound"]).toContain(request.status);
    if (request.status === "pending") {
      await resolvePluginConversationBindingApproval({
        approvalId: request.approvalId,
        decision: "allow-once",
        senderId: "user-1",
      });
    }

    const current = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-a",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
    });

    expect(current).toEqual(
      expect.objectContaining({
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
        conversationId: "channel:1",
      }),
    );

    const otherPluginView = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-b",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
    });

    expect(otherPluginView).toBeNull();

    expect(
      await detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-b",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:1",
        },
      }),
    ).toEqual({ removed: false });

    expect(
      await detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-a",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:1",
        },
      }),
    ).toEqual({ removed: true });
  });

  it("refuses to claim a conversation already bound by core", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-core",
      targetSessionKey: "agent:main:discord:channel:1",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: { owner: "core" },
    });

    const result = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    expect(result).toEqual({
      status: "error",
      message:
        "This conversation is already bound by core routing and cannot be claimed by a plugin.",
    });
  });

  it("migrates a legacy plugin binding record through the new approval flow", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-legacy",
      targetSessionKey: "plugin-binding:codex:legacy123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: {
        label: "legacy plugin bind",
      },
    });

    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: "77",
      },
      binding: { summary: "Bind this conversation to Codex thread abc." },
    });

    expect(["pending", "bound"]).toContain(request.status);
    const binding =
      request.status === "pending"
        ? await resolvePluginConversationBindingApproval({
            approvalId: request.approvalId,
            decision: "allow-once",
            senderId: "user-1",
          }).then((approved) => {
            expect(approved.status).toBe("approved");
            if (approved.status !== "approved") {
              throw new Error("expected approved bind result");
            }
            return approved.binding;
          })
        : request.binding;

    expect(binding).toEqual(
      expect.objectContaining({
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
        conversationId: "-10099:topic:77",
      }),
    );
  });
});
