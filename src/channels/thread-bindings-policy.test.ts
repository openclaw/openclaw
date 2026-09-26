import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
// Thread binding policy tests cover how channel thread bindings are created and reused.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "./thread-bindings-policy.js";

describe("thread binding spawn policy helpers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "child-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "child-chat", label: "Child chat" }),
            conversationBindings: { defaultTopLevelPlacement: "child" },
          },
        },
        {
          pluginId: "current-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "current-chat", label: "Current chat" }),
            conversationBindings: { defaultTopLevelPlacement: "current" },
          },
        },
      ]),
    );
  });

  it("treats child-placement channels as automatic child-thread spawn channels", () => {
    expect(supportsAutomaticThreadBindingSpawn("child-chat")).toBe(true);
    expect(supportsAutomaticThreadBindingSpawn("current-chat")).toBe(false);
    expect(supportsAutomaticThreadBindingSpawn("unknown-chat")).toBe(false);
  });

  it("enables user ACP thread spawns by default", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: {},
      channel: "discord",
      kind: "acp",
    });

    expect(policy.enabled).toBe(true);
    expect(policy.spawnEnabled).toBe(true);
  });

  it("preserves long lifecycle hour values while capping unsafe conversions", () => {
    expect(
      resolveThreadBindingIdleTimeoutMs({
        channelIdleHoursRaw: 720,
        sessionIdleHoursRaw: undefined,
      }),
    ).toBe(2_592_000_000);
    expect(
      resolveThreadBindingMaxAgeMs({
        channelMaxAgeHoursRaw: undefined,
        sessionMaxAgeHoursRaw: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("uses spawnSessions to gate user ACP thread spawns", () => {
    const cfg = {
      channels: {
        discord: {
          threadBindings: { spawnSessions: false },
        },
      },
    };

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(false);
  });

  it("lets account config override channel spawnSessions", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
            accounts: {
              work: {
                threadBindings: {
                  spawnSessions: true,
                },
              },
            },
          },
        },
      },
      channel: "discord",
      accountId: "work",
      kind: "acp",
    });

    expect(policy.spawnEnabled).toBe(true);
  });
});
