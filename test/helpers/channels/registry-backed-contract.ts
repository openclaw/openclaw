import { afterEach, beforeEach, describe } from "vitest";
import { feishuThreadBindingTesting } from "../../../extensions/feishu/api.js";
import { resetMatrixThreadBindingsForTests } from "../../../extensions/matrix/api.js";
import {
  actionContractRegistry,
  directoryContractRegistry,
  pluginContractRegistry,
  sessionBindingContractRegistry,
  setupContractRegistry,
  statusContractRegistry,
  surfaceContractRegistry,
  threadingContractRegistry,
} from "../../../src/channels/plugins/contracts/registry.js";
import {
  installChannelActionsContractSuite,
  installChannelDirectoryContractSuite,
  installChannelPluginContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
  installChannelSurfaceContractSuite,
  installChannelThreadingContractSuite,
  installSessionBindingContractSuite,
} from "../../../src/channels/plugins/contracts/suites.js";
import { setDefaultChannelPluginRegistryForTests } from "../../../src/commands/channel-test-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import { __testing as sessionBindingTesting } from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

const { discordThreadBindingTesting } = loadBundledPluginTestApiSync<{
  discordThreadBindingTesting: {
    resetThreadBindingsForTests: () => void;
  };
}>("discord");
const { resetTelegramThreadBindingsForTests } = loadBundledPluginTestApiSync<{
  resetTelegramThreadBindingsForTests: () => Promise<void>;
}>("telegram");

function hasEntries<T extends { id: string }>(
  entries: readonly T[],
  id: string,
): entries is readonly T[] {
  return entries.some((entry) => entry.id === id);
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

export function describeChannelRegistryBackedContracts(id: string) {
  if (hasEntries(pluginContractRegistry, id)) {
    const entry = pluginContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} plugin contract`, () => {
      installChannelPluginContractSuite({
        plugin: entry.plugin,
      });
    });
  }

  if (hasEntries(actionContractRegistry, id)) {
    const entry = actionContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} actions contract`, () => {
      installChannelActionsContractSuite({
        plugin: entry.plugin,
        cases: entry.cases as never,
        unsupportedAction: entry.unsupportedAction as never,
      });
    });
  }

  if (hasEntries(setupContractRegistry, id)) {
    const entry = setupContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} setup contract`, () => {
      installChannelSetupContractSuite({
        plugin: entry.plugin,
        cases: entry.cases as never,
      });
    });
  }

  if (hasEntries(statusContractRegistry, id)) {
    const entry = statusContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} status contract`, () => {
      installChannelStatusContractSuite({
        plugin: entry.plugin,
        cases: entry.cases as never,
      });
    });
  }

  for (const entry of surfaceContractRegistry.filter((item) => item.id === id)) {
    for (const surface of entry.surfaces) {
      describe(`${entry.id} ${surface} surface contract`, () => {
        installChannelSurfaceContractSuite({
          plugin: entry.plugin,
          surface,
        });
      });
    }
  }

  if (hasEntries(threadingContractRegistry, id)) {
    const entry = threadingContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} threading contract`, () => {
      installChannelThreadingContractSuite({
        plugin: entry.plugin,
      });
    });
  }

  if (hasEntries(directoryContractRegistry, id)) {
    const entry = directoryContractRegistry.find((item) => item.id === id)!;
    describe(`${entry.id} directory contract`, () => {
      installChannelDirectoryContractSuite({
        plugin: entry.plugin,
        coverage: entry.coverage,
        cfg: entry.cfg,
        accountId: entry.accountId,
      });
    });
  }
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
      discordThreadBindingTesting.resetThreadBindingsForTests();
      feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
      resetMatrixThreadBindingsForTests();
      await resetTelegramThreadBindingsForTests();
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
