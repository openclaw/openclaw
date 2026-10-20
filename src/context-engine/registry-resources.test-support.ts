import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";

export function createRegistryFixture(
  dispose: () => void = () => {},
  registry = createEmptyPluginRegistry(),
  owner = "fixture",
) {
  const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
  const retired = vi.fn(dispose);
  resources.attach(registry);
  resources.register(owner, { id: "native", dispose: retired });
  return { registry, resources, retired };
}

export function createNativeSource(
  file = ":memory:",
  registry = createEmptyPluginRegistry(),
  owner = "fixture",
  afterClose: () => void = () => {},
) {
  const database = new DatabaseSync(file);
  const disposed = createDeferred();
  const state = {
    get open() {
      return database.isOpen;
    },
    disposals: 0,
  };
  const retire = () => {
    state.disposals++;
    database.close();
    disposed.resolve();
    afterClose();
  };
  const read = () => Number(database.prepare("SELECT 42 AS value").get()?.value);
  return { ...createRegistryFixture(retire, registry, owner), database, disposed, state, read };
}
