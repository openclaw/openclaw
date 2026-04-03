import { afterEach, beforeEach, describe } from "vitest";
import { sessionBindingContractRegistry } from "../../../src/channels/plugins/contracts/registry-session-binding.js";
import { installSessionBindingContractSuite } from "../../../src/channels/plugins/contracts/suites.js";
import { setDefaultChannelPluginRegistryForTests } from "../../../src/commands/channel-test-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import { __testing as sessionBindingTesting } from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

type ResetTelegramThreadBindingsForTests = () => Promise<void>;

let discordThreadBindingTestingCache: DiscordThreadBindingTesting | undefined;
let resetTelegramThreadBindingsForTestsCache: ResetTelegramThreadBindingsForTests | undefined;
let feishuApiPromise: Promise<typeof import("../../../extensions/feishu/api.js")> | undefined;
let matrixApiPromise: Promise<typeof import("../../../extensions/matrix/api.js")> | undefined;

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

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = sessionBindingContractRegistry.find((item) => item.id === id);
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
      setDefaultChannelPluginRegistryForTests();
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
