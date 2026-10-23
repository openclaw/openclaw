import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "./thread-bindings-policy.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(
      (["child", "current"] as const).map((placement) => ({
        pluginId: `${placement}-chat`,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: `${placement}-chat`, label: `${placement} chat` }),
          conversationBindings: { defaultTopLevelPlacement: placement },
        },
      })),
    ),
  );
});

it("treats child-placement channels as automatic child-thread spawn channels", () => {
  expect(supportsAutomaticThreadBindingSpawn("child-chat")).toBe(true);
  expect(supportsAutomaticThreadBindingSpawn("current-chat")).toBe(false);
  expect(supportsAutomaticThreadBindingSpawn("unknown-chat")).toBe(false);
});

it("enables unified thread-bound session spawns by default", () => {
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: {},
    channel: "discord",
    kind: "subagent",
  });

  expect(policy).toMatchObject({
    enabled: true,
    spawnEnabled: true,
    defaultSpawnContext: "fork",
  });
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

it("uses spawnSessions for both subagent and ACP spawn policy", () => {
  const cfg = { channels: { discord: { threadBindings: { spawnSessions: false } } } };
  for (const kind of ["subagent", "acp"] as const) {
    expect(resolveThreadBindingSpawnPolicy({ cfg, channel: "discord", kind }).spawnEnabled).toBe(
      false,
    );
  }
});

it("lets account config override channel spawnSessions and spawn context", () => {
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: {
      channels: {
        discord: {
          threadBindings: { spawnSessions: false, defaultSpawnContext: "fork" },
          accounts: {
            work: {
              threadBindings: { spawnSessions: true, defaultSpawnContext: "isolated" },
            },
          },
        },
      },
    },
    channel: "discord",
    accountId: "work",
    kind: "subagent",
  });

  expect(policy).toMatchObject({ spawnEnabled: true, defaultSpawnContext: "isolated" });
});
