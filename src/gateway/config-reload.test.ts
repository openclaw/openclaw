import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
} from "./config-reload.js";

describe("diffConfigPaths", () => {
  it("captures nested config changes", () => {
    const prev = { hooks: { gmail: { account: "a" } } };
    const next = { hooks: { gmail: { account: "b" } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("hooks.gmail.account");
  });

  it("captures array changes", () => {
    const prev = { messages: { groupChat: { mentionPatterns: ["a"] } } };
    const next = { messages: { groupChat: { mentionPatterns: ["b"] } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("messages.groupChat.mentionPatterns");
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
  ]);

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the Gmail watcher for hooks.gmail changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.gmail.account"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartGmailWatcher).toBe(true);
    expect(plan.reloadHooks).toBe(true);
  });

  it("restarts providers when provider config prefixes change", () => {
    const changedPaths = ["web.enabled", "channels.telegram.botToken"];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    const expected = new Set(
      listChannelPlugins()
        .filter((plugin) =>
          (plugin.reload?.configPrefixes ?? []).some((prefix) =>
            changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}.`)),
          ),
        )
        .map((plugin) => plugin.id),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(plan.restartChannels).toEqual(expected);
  });

  it("treats gateway.remote as no-op", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("defaults unknown paths to restart", () => {
    const plan = buildGatewayReloadPlan(["unknownField"]);
    expect(plan.restartGateway).toBe(true);
  });
});

describe("resolveGatewayReloadSettings", () => {
  it("uses defaults when unset", () => {
    const settings = resolveGatewayReloadSettings({});
    expect(settings.mode).toBe("hybrid");
    expect(settings.debounceMs).toBe(300);
  });
});

describe("config reload max-wait debounce", () => {
  it("computeDebounceWait respects max-wait ceiling", async () => {
    const { computeDebounceWait } = await import("./config-reload.js");

    const debounceMs = 100;
    const maxWaitMs = 300; // 3x debounceMs

    // First call: no start time, should return full debounce and a start time
    const first = computeDebounceWait({ debounceMs, maxWaitMs, debounceStart: null, now: 1000 });
    expect(first.wait).toBe(debounceMs);
    expect(first.debounceStart).toBe(1000);

    // Second call after 50ms: still has 250ms of max-wait, so full debounce
    const second = computeDebounceWait({ debounceMs, maxWaitMs, debounceStart: 1000, now: 1050 });
    expect(second.wait).toBe(debounceMs);
    expect(second.debounceStart).toBe(1000); // unchanged

    // Third call after 250ms: only 50ms of max-wait left, so wait should be 50ms
    const third = computeDebounceWait({ debounceMs, maxWaitMs, debounceStart: 1000, now: 1250 });
    expect(third.wait).toBe(50);
    expect(third.debounceStart).toBe(1000);

    // Fourth call after max-wait exceeded: should trigger immediately (wait = 0)
    const fourth = computeDebounceWait({ debounceMs, maxWaitMs, debounceStart: 1000, now: 1350 });
    expect(fourth.wait).toBe(0);
    expect(fourth.debounceStart).toBe(1000);
  });
});
