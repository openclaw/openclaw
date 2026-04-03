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
});
