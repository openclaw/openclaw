import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bluebubblesPlugin } from "../../../extensions/bluebubbles/api.js";
import {
  discordPlugin,
  discordThreadBindingTesting,
} from "../../../extensions/discord/test-api.js";
import { feishuPlugin, feishuThreadBindingTesting } from "../../../extensions/feishu/api.js";
import { imessagePlugin } from "../../../extensions/imessage/api.js";
import { matrixPlugin, setMatrixRuntime } from "../../../extensions/matrix/test-api.js";
import { telegramPlugin } from "../../../extensions/telegram/api.js";
import { resetTelegramThreadBindingsForTests } from "../../../extensions/telegram/test-api.js";
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
import { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";
import { getSessionBindingContractRegistry } from "./registry-session-binding.js";

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

type ResetTelegramThreadBindingsForTests = () => Promise<void>;

function getBluebubblesPlugin(): ChannelPlugin {
  return bluebubblesPlugin as unknown as ChannelPlugin;
}

function getDiscordPlugin(): ChannelPlugin {
  return discordPlugin as unknown as ChannelPlugin;
}

function getFeishuPlugin(): ChannelPlugin {
  return feishuPlugin as unknown as ChannelPlugin;
}

function getIMessagePlugin(): ChannelPlugin {
  return imessagePlugin as unknown as ChannelPlugin;
}

function getMatrixPlugin(): ChannelPlugin {
  return matrixPlugin as unknown as ChannelPlugin;
}

function getSetMatrixRuntime(): (runtime: PluginRuntime) => void {
  return setMatrixRuntime;
}

function getTelegramPlugin(): ChannelPlugin {
  return telegramPlugin as unknown as ChannelPlugin;
}

function getDiscordThreadBindingTesting(): DiscordThreadBindingTesting {
  return discordThreadBindingTesting;
}

function getResetTelegramThreadBindingsForTests(): ResetTelegramThreadBindingsForTests {
  return resetTelegramThreadBindingsForTests;
}

async function getFeishuThreadBindingTesting() {
  return feishuThreadBindingTesting;
}

async function getResetMatrixThreadBindingsForTests() {
  const matrixApi = await import("../../../extensions/matrix/api.js");
  return matrixApi.resetMatrixThreadBindingsForTests;
}

function resolveSessionBindingContractRuntimeConfig(id: string) {
  if (id !== "discord" && id !== "matrix") {
    return {};
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
      // Keep the suite hermetic; some contract helpers resolve runtime artifacts through config-aware
      // plugin boundaries, so never fall back to the developer's real ~/.openclaw/openclaw.json here.
      const runtimeConfig = resolveSessionBindingContractRuntimeConfig(entry.id);
      // These registry-backed contract suites intentionally exercise bundled runtime facades.
      // Opt the bundled-runtime cases in so the activation boundary behaves like real runtime usage.
      setRuntimeConfigSnapshot(runtimeConfig);
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
