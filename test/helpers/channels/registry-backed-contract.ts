import { describe } from "vitest";
import {
  actionContractRegistry,
  directoryContractRegistry,
  pluginContractRegistry,
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
} from "../../../src/channels/plugins/contracts/suites.js";

function hasEntries<T extends { id: string }>(
  entries: readonly T[],
  id: string,
): entries is readonly T[] {
  return entries.some((entry) => entry.id === id);
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
