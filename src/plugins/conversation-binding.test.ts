import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

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
  buildPluginBindingApprovalCustomId,
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  parsePluginBindingApprovalCustomId,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
} = await import("./conversation-binding.js");
const { registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
  await import("../infra/outbound/session-binding-service.js");

type PluginBindingRequest = Awaited<ReturnType<typeof requestPluginConversationBinding>>;

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

async function resolveRequestedBinding(request: PluginBindingRequest) {
  expect(["pending", "bound"]).toContain(request.status);
  if (request.status === "pending") {
    const approved = await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-once",
      senderId: "user-1",
    });
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") {
      throw new Error("expected approved bind result");
    }
    return approved.binding;
  }
  if (request.status === "bound") {
    return request.binding;
  }
  throw new Error("expected pending or bound bind result");
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("plugin conversation binding approvals", () => {
  beforeEach(() => {
    sessionBindingState.reset();
    __testing.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
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

  it("keeps Telegram bind approval callback_data within Telegram's limit", () => {
    const allowOnce = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-once");
    const allowAlways = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-always");
    const deny = buildPluginBindingApprovalCustomId("abcdefghijkl", "deny");

    expect(Buffer.byteLength(allowOnce, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(allowAlways, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(deny, "utf8")).toBeLessThanOrEqual(64);
    expect(parsePluginBindingApprovalCustomId(allowAlways)).toEqual({
      approvalId: "abcdefghijkl",
      decision: "allow-always",
    });
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

  it("persists detachHint on approved plugin bindings", async () => {
    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:detach-hint",
      },
      binding: {
        summary: "Bind this conversation to Codex thread 999.",
        detachHint: "/codex_detach",
      },
    });

    expect(["pending", "bound"]).toContain(request.status);

    if (request.status === "pending") {
      const approved = await resolvePluginConversationBindingApproval({
        approvalId: request.approvalId,
        decision: "allow-once",
        senderId: "user-1",
      });

      expect(approved.status).toBe("approved");
      if (approved.status !== "approved") {
        throw new Error("expected approved bind request");
      }

      expect(approved.binding.detachHint).toBe("/codex_detach");
    } else if (request.status === "bound") {
      expect(request.binding.detachHint).toBe("/codex_detach");
    } else {
      throw new Error(`expected pending or bound request, got ${request.status}`);
    }

    const currentBinding = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-a",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:detach-hint",
      },
    });

    expect(currentBinding?.detachHint).toBe("/codex_detach");
  });

  it("notifies the owning plugin when a bind approval is approved", async () => {
    const registry = createEmptyPluginRegistry();
    const onResolved = vi.fn(async () => undefined);
    registry.conversationBindingResolvedHandlers.push({
      pluginId: "codex",
      pluginRoot: "/plugins/callback-test",
      handler: onResolved,
      source: "/plugins/callback-test/index.ts",
      rootDir: "/plugins/callback-test",
    });
    setActivePluginRegistry(registry);

    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/callback-test",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:callback-test",
      },
      binding: { summary: "Bind this conversation to Codex thread abc." },
    });

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    const approved = await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-once",
      senderId: "user-1",
    });

    expect(approved.status).toBe("approved");
    await flushMicrotasks();
    expect(onResolved).toHaveBeenCalledWith({
      status: "approved",
      binding: expect.objectContaining({
        pluginId: "codex",
        pluginRoot: "/plugins/callback-test",
        conversationId: "channel:callback-test",
      }),
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread abc.",
        detachHint: undefined,
        requestedBySenderId: "user-1",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:callback-test",
        },
      },
    });
  });

  it("notifies the owning plugin when a bind approval is denied", async () => {
    const registry = createEmptyPluginRegistry();
    const onResolved = vi.fn(async () => undefined);
    registry.conversationBindingResolvedHandlers.push({
      pluginId: "codex",
      pluginRoot: "/plugins/callback-deny",
      handler: onResolved,
      source: "/plugins/callback-deny/index.ts",
      rootDir: "/plugins/callback-deny",
    });
    setActivePluginRegistry(registry);

    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/callback-deny",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: { summary: "Bind this conversation to Codex thread deny." },
    });

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    const denied = await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "deny",
      senderId: "user-1",
    });

    expect(denied.status).toBe("denied");
    await flushMicrotasks();
    expect(onResolved).toHaveBeenCalledWith({
      status: "denied",
      binding: undefined,
      decision: "deny",
      request: {
        summary: "Bind this conversation to Codex thread deny.",
        detachHint: undefined,
        requestedBySenderId: "user-1",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
      },
    });
  });

  it("does not wait for an approved bind callback before returning", async () => {
    const registry = createEmptyPluginRegistry();
    const callbackGate = createDeferredVoid();
    const onResolved = vi.fn(async () => callbackGate.promise);
    registry.conversationBindingResolvedHandlers.push({
      pluginId: "codex",
      pluginRoot: "/plugins/callback-slow-approve",
      handler: onResolved,
      source: "/plugins/callback-slow-approve/index.ts",
      rootDir: "/plugins/callback-slow-approve",
    });
    setActivePluginRegistry(registry);

    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/callback-slow-approve",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:slow-approve",
      },
      binding: { summary: "Bind this conversation to Codex thread slow-approve." },
    });

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    let settled = false;
    const resolutionPromise = resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-once",
      senderId: "user-1",
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(onResolved).toHaveBeenCalledTimes(1);

    callbackGate.resolve();
    const approved = await resolutionPromise;
    expect(approved.status).toBe("approved");
  });

  it("does not wait for a denied bind callback before returning", async () => {
    const registry = createEmptyPluginRegistry();
    const callbackGate = createDeferredVoid();
    const onResolved = vi.fn(async () => callbackGate.promise);
    registry.conversationBindingResolvedHandlers.push({
      pluginId: "codex",
      pluginRoot: "/plugins/callback-slow-deny",
      handler: onResolved,
      source: "/plugins/callback-slow-deny/index.ts",
      rootDir: "/plugins/callback-slow-deny",
    });
    setActivePluginRegistry(registry);

    const request = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/callback-slow-deny",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "slow-deny",
      },
      binding: { summary: "Bind this conversation to Codex thread slow-deny." },
    });

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    let settled = false;
    const resolutionPromise = resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "deny",
      senderId: "user-1",
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(onResolved).toHaveBeenCalledTimes(1);

    callbackGate.resolve();
    const denied = await resolutionPromise;
    expect(denied.status).toBe("denied");
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

  it("migrates a legacy plugin binding record through the new approval flow even if the old plugin id differs", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-legacy",
      targetSessionKey: "plugin-binding:old-codex-plugin:legacy123",
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

    const binding = await resolveRequestedBinding(request);

    expect(binding).toEqual(
      expect.objectContaining({
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
        conversationId: "-10099:topic:77",
      }),
    );
  });

  it("migrates a legacy codex thread binding session key through the new approval flow", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-legacy-codex-thread",
      targetSessionKey: "openclaw-app-server:thread:019ce411-6322-7db2-a821-1a61c530e7d9",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: {
        label: "legacy codex thread bind",
      },
    });

    const request = await requestPluginConversationBinding({
      pluginId: "openclaw-codex-app-server",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: {
        summary: "Bind this conversation to Codex thread 019ce411-6322-7db2-a821-1a61c530e7d9.",
      },
    });

    const binding = await resolveRequestedBinding(request);

    expect(binding).toEqual(
      expect.objectContaining({
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex-a",
        conversationId: "8460800771",
      }),
    );
  });
});
