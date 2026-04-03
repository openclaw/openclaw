import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionBindingContractRegistry } from "../../../src/channels/plugins/contracts/registry-session-binding.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  __testing as sessionBindingTesting,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/index.js";
import {
  loadBundledPluginPublicSurfaceSync,
  loadBundledPluginTestApiSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

type ResetTelegramThreadBindingsForTests = () => Promise<void>;

let discordThreadBindingTestingCache: DiscordThreadBindingTesting | undefined;
let resetTelegramThreadBindingsForTestsCache: ResetTelegramThreadBindingsForTests | undefined;
let feishuApiPromise: Promise<typeof import("../../../extensions/feishu/api.js")> | undefined;
let matrixApiPromise: Promise<typeof import("../../../extensions/matrix/api.js")> | undefined;
let bluebubblesPluginCache: ChannelPlugin | undefined;
let discordPluginCache: ChannelPlugin | undefined;
let feishuPluginCache: ChannelPlugin | undefined;
let imessagePluginCache: ChannelPlugin | undefined;
let matrixPluginCache: ChannelPlugin | undefined;
let setMatrixRuntimeCache: ((runtime: PluginRuntime) => void) | undefined;
let telegramPluginCache: ChannelPlugin | undefined;

function getBluebubblesPlugin(): ChannelPlugin {
  if (!bluebubblesPluginCache) {
    ({ bluebubblesPlugin: bluebubblesPluginCache } = loadBundledPluginPublicSurfaceSync<{
      bluebubblesPlugin: ChannelPlugin;
    }>({ pluginId: "bluebubbles", artifactBasename: "api.js" }));
  }
  return bluebubblesPluginCache;
}

function getDiscordPlugin(): ChannelPlugin {
  if (!discordPluginCache) {
    ({ discordPlugin: discordPluginCache } = loadBundledPluginTestApiSync<{
      discordPlugin: ChannelPlugin;
    }>("discord"));
  }
  return discordPluginCache;
}

function getFeishuPlugin(): ChannelPlugin {
  if (!feishuPluginCache) {
    ({ feishuPlugin: feishuPluginCache } = loadBundledPluginPublicSurfaceSync<{
      feishuPlugin: ChannelPlugin;
    }>({ pluginId: "feishu", artifactBasename: "api.js" }));
  }
  return feishuPluginCache;
}

function getIMessagePlugin(): ChannelPlugin {
  if (!imessagePluginCache) {
    ({ imessagePlugin: imessagePluginCache } = loadBundledPluginPublicSurfaceSync<{
      imessagePlugin: ChannelPlugin;
    }>({ pluginId: "imessage", artifactBasename: "api.js" }));
  }
  return imessagePluginCache;
}

function getMatrixPlugin(): ChannelPlugin {
  if (!matrixPluginCache) {
    ({ matrixPlugin: matrixPluginCache, setMatrixRuntime: setMatrixRuntimeCache } =
      loadBundledPluginTestApiSync<{
        matrixPlugin: ChannelPlugin;
        setMatrixRuntime: (runtime: PluginRuntime) => void;
      }>("matrix"));
  }
  return matrixPluginCache;
}

function getSetMatrixRuntime(): (runtime: PluginRuntime) => void {
  if (!setMatrixRuntimeCache) {
    void getMatrixPlugin();
  }
  return setMatrixRuntimeCache!;
}

function getTelegramPlugin(): ChannelPlugin {
  if (!telegramPluginCache) {
    ({ telegramPlugin: telegramPluginCache } = loadBundledPluginTestApiSync<{
      telegramPlugin: ChannelPlugin;
    }>("telegram"));
  }
  return telegramPluginCache;
}

function getDiscordThreadBindingTesting(): DiscordThreadBindingTesting {
  if (!discordThreadBindingTestingCache) {
    ({ discordThreadBindingTesting: discordThreadBindingTestingCache } =
      loadBundledPluginTestApiSync<{
        discordThreadBindingTesting: DiscordThreadBindingTesting;
      }>("discord"));
  }
  return discordThreadBindingTestingCache;
}

function getResetTelegramThreadBindingsForTests(): ResetTelegramThreadBindingsForTests {
  if (!resetTelegramThreadBindingsForTestsCache) {
    ({ resetTelegramThreadBindingsForTests: resetTelegramThreadBindingsForTestsCache } =
      loadBundledPluginTestApiSync<{
        resetTelegramThreadBindingsForTests: ResetTelegramThreadBindingsForTests;
      }>("telegram"));
  }
  return resetTelegramThreadBindingsForTestsCache;
}

async function getFeishuThreadBindingTesting() {
  feishuApiPromise ??= import("../../../extensions/feishu/api.js");
  return (await feishuApiPromise).feishuThreadBindingTesting;
}

async function getResetMatrixThreadBindingsForTests() {
  matrixApiPromise ??= import("../../../extensions/matrix/api.js");
  return (await matrixApiPromise).resetMatrixThreadBindingsForTests;
}

function resolveSessionBindingContractRuntimeConfig(id: string) {
  if (id !== "discord" && id !== "matrix") {
    return null;
  }
  return {
    plugins: {
      entries: {
        [id]: {
          enabled: true,
        },
      },
    },
  };
}

function setSessionBindingPluginRegistryForTests(): void {
  getSetMatrixRuntime()({
    state: {
      resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
    },
  } as PluginRuntime);

  const channels = [
    getBluebubblesPlugin(),
    getDiscordPlugin(),
    getFeishuPlugin(),
    getIMessagePlugin(),
    getMatrixPlugin(),
    getTelegramPlugin(),
  ].map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as Parameters<typeof createTestRegistry>[0];

  setActivePluginRegistry(createTestRegistry(channels));
}

function installSessionBindingContractSuite(params: {
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  expectedCapabilities: SessionBindingCapabilities;
}) {
  it("registers the expected session binding capabilities", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
  });

  it("binds and resolves a session binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    expect(typeof binding.bindingId).toBe("string");
    expect(binding.bindingId.trim()).not.toBe("");
    expect(typeof binding.targetSessionKey).toBe("string");
    expect(binding.targetSessionKey.trim()).not.toBe("");
    expect(["session", "subagent"]).toContain(binding.targetKind);
    expect(typeof binding.conversation.channel).toBe("string");
    expect(typeof binding.conversation.accountId).toBe("string");
    expect(typeof binding.conversation.conversationId).toBe("string");
    expect(["active", "ending", "ended"]).toContain(binding.status);
    expect(typeof binding.boundAt).toBe("number");
  });

  it("unbinds a registered binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    await params.unbindAndVerify(binding);
  });

  it("cleans up registered bindings", async () => {
    await params.cleanup();
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
    beforeEach(async () => {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      const runtimeConfig = resolveSessionBindingContractRuntimeConfig(entry.id);
      if (runtimeConfig) {
        // These registry-backed contract suites intentionally exercise bundled runtime facades.
        // Opt those specific plugins in so the activation boundary behaves like real runtime usage.
        setRuntimeConfigSnapshot(runtimeConfig);
      }
      // These suites only exercise the session-binding channels, so avoid the broader
      // default registry helper and seed only the six plugins this contract lane needs.
      setSessionBindingPluginRegistryForTests();
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      getDiscordThreadBindingTesting().resetThreadBindingsForTests();
      (await getFeishuThreadBindingTesting()).resetFeishuThreadBindingsForTests();
      (await getResetMatrixThreadBindingsForTests())();
      await getResetTelegramThreadBindingsForTests()();
    });
    afterEach(() => {
      clearRuntimeConfigSnapshot();
    });

    installSessionBindingContractSuite({
      expectedCapabilities: entry.expectedCapabilities,
      getCapabilities: entry.getCapabilities,
      bindAndResolve: entry.bindAndResolve,
      unbindAndVerify: entry.unbindAndVerify,
      cleanup: entry.cleanup,
    });
  });
}
