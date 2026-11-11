import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveThreadBindingIdleTimeoutMs as idleMs,
  resolveThreadBindingIdleTimeoutMsForChannel as channelIdleMs,
  resolveThreadBindingMaxAgeMs as maxAgeMs,
  resolveThreadBindingMaxAgeMsForChannel as channelMaxAgeMs,
  resolveThreadBindingSpawnPolicy as spawnPolicy,
  supportsAutomaticThreadBindingSpawn as automaticSpawn,
} from "./thread-bindings-policy.js";

beforeEach(() => {
  const plugins = (["child", "current"] as const).map((placement) => ({
    pluginId: `${placement}-chat`,
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id: `${placement}-chat`, label: `${placement} chat` }),
      conversationBindings: { defaultTopLevelPlacement: placement },
    },
  }));
  setActivePluginRegistry(createTestRegistry(plugins));
});

it("treats child-placement channels as automatic child-thread spawn channels", () => {
  expect(automaticSpawn("child-chat")).toBe(true);
  expect(automaticSpawn("current-chat")).toBe(false);
  expect(automaticSpawn("unknown-chat")).toBe(false);
});

it("enables unified thread-bound session spawns by default", () => {
  expect(spawnPolicy({ cfg: {}, channel: "discord", kind: "subagent" })).toMatchObject({
    enabled: true,
    spawnEnabled: true,
    defaultSpawnContext: "fork",
  });
});

it("preserves long lifecycle hour values while capping unsafe conversions", () => {
  expect(idleMs({ channelIdleHoursRaw: 720, sessionIdleHoursRaw: undefined })).toBe(2_592_000_000);
  expect(
    maxAgeMs({
      channelMaxAgeHoursRaw: undefined,
      sessionMaxAgeHoursRaw: Number.MAX_SAFE_INTEGER,
    }),
  ).toBe(MAX_DATE_TIMESTAMP_MS);
});

it("uses spawnSessions for both subagent and ACP spawn policy", () => {
  const cfg = { channels: { discord: { threadBindings: { spawnSessions: false } } } };
  for (const kind of ["subagent", "acp"] as const) {
    expect(spawnPolicy({ cfg, channel: "discord", kind }).spawnEnabled).toBe(false);
  }
});

it.each(["work", "Work"])("applies account %s overrides", (key) => {
  const bindings = (spawn: boolean, context: "fork" | "isolated", hours: number) => ({
    spawnSessions: spawn,
    defaultSpawnContext: context,
    idleHours: hours,
    maxAgeHours: hours * 2,
  });
  const discord = {
    threadBindings: bindings(false, "fork", 24),
    accounts: { [key]: { threadBindings: bindings(true, "isolated", 1) } },
  };
  const cfg: OpenClawConfig = { channels: { discord } };
  const scope = { cfg, channel: "discord", accountId: "work" };

  expect(spawnPolicy({ ...scope, kind: "subagent" })).toMatchObject({
    spawnEnabled: true,
    defaultSpawnContext: "isolated",
  });
  expect(channelIdleMs(scope)).toBe(60 * 60 * 1000);
  expect(channelMaxAgeMs(scope)).toBe(2 * 60 * 60 * 1000);
});
