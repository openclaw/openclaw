import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  __testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  resolveGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          id: "slack",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("advertises support only for channels that opt into current-conversation binds", () => {
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "slack",
        accountId: "default",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "definitely-not-a-channel",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("requires an active channel plugin registration", () => {
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "slack",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("reloads persisted bindings after the in-memory cache is cleared", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:slack-dm",
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "slack-dm",
      },
    });

    expect(bound).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
      metadata: expect.objectContaining({
        label: "slack-dm",
      }),
    });
  });

  it("removes persisted bindings on unbind", async () => {
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      targetKind: "session",
      conversation: {
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      },
    });

    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      reason: "test cleanup",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      }),
    ).toBeNull();
  });

  it("saves previousBinding in metadata when rebinding to a different session", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U999",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:coder:acp:2",
      targetKind: "session",
      conversation,
    });

    const binding = resolveGenericCurrentConversationBinding(conversation);
    expect(binding).toMatchObject({
      targetSessionKey: "agent:coder:acp:2",
    });
    expect(binding?.metadata?.previousBinding).toMatchObject({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
    });
  });

  it("does not save previousBinding when rebinding to the same session", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U888",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
      metadata: { label: "refreshed" },
    });

    const binding = resolveGenericCurrentConversationBinding(conversation);
    expect(binding?.targetSessionKey).toBe("agent:main:session:1");
    expect(binding?.metadata?.previousBinding).toBeUndefined();
  });

  it("restores previous binding on unbind", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U777",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:coder:acp:2",
      targetKind: "session",
      conversation,
    });

    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:coder:acp:2",
      reason: "session-end",
    });

    const restored = resolveGenericCurrentConversationBinding(conversation);
    expect(restored).toMatchObject({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
    });
    expect(restored?.metadata?.restoredFrom).toBe("agent:coder:acp:2");
  });

  it("restores stacked bindings in correct order", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U666",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:coder:acp:2",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:analyst:acp:3",
      targetKind: "session",
      conversation,
    });

    // Unbind analyst → should revert to coder
    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:analyst:acp:3",
      reason: "session-end",
    });
    expect(resolveGenericCurrentConversationBinding(conversation)).toMatchObject({
      targetSessionKey: "agent:coder:acp:2",
    });

    // Unbind coder → should revert to main
    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:coder:acp:2",
      reason: "session-end",
    });
    expect(resolveGenericCurrentConversationBinding(conversation)).toMatchObject({
      targetSessionKey: "agent:main:session:1",
    });
  });

  it("restores previous binding when specialist expires via TTL", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U555",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:coder:acp:2",
      targetKind: "session",
      conversation,
      ttlMs: 1,
    });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Resolve triggers pruneExpiredBinding which should restore main
    const restored = resolveGenericCurrentConversationBinding(conversation);
    expect(restored).toMatchObject({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
    });
    expect(restored?.metadata?.restoredFrom).toBe("agent:coder:acp:2");
  });

  it("does not delete restored binding when late bindingId unbind races with TTL expiry", async () => {
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "dm:U444",
    };

    await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
      conversation,
    });

    const specialist = await bindGenericCurrentConversation({
      targetSessionKey: "agent:coder:acp:2",
      targetKind: "session",
      conversation,
      ttlMs: 1,
    });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Late unbind by stale bindingId — should not destroy the restored main binding
    await unbindGenericCurrentConversationBindings({
      bindingId: specialist!.bindingId,
      reason: "session-end",
    });

    const afterUnbind = resolveGenericCurrentConversationBinding(conversation);
    expect(afterUnbind).toMatchObject({
      targetSessionKey: "agent:main:session:1",
      targetKind: "session",
    });
  });
});
