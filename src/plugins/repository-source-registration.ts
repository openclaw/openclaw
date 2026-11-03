import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import type { RepositorySourceV1 } from "./repository-source-types.js";

export function createRepositorySourceRegistrar(state: PluginRegistryState) {
  return (record: PluginRecord, source: RepositorySourceV1) => {
    const instance = getPluginInstance(record);
    if (
      !instance ||
      !record.repositorySources?.some((declared) => declared.id === source.id) ||
      typeof source.resolve !== "function" ||
      typeof source.prepare !== "function" ||
      (source.worker !== undefined &&
        (typeof source.worker.prepare !== "function" ||
          typeof source.worker.checkout !== "function"))
    ) {
      state.reportRegistrationError(
        record,
        "repository source requires its declared ID and managed preparers",
      );
      return;
    }
    if (
      state.registry.repositorySources.some(
        (entry) => entry.pluginId === record.id && entry.provider.id === source.id,
      )
    ) {
      state.reportRegistrationError(record, `repository source already registered: ${source.id}`);
      return;
    }
    instance.admitFactory(source.prepare, ["assertCurrent", "resolveBase"]);
    if (source.worker) {
      if (source.worker.restore) {
        instance.admitFactory(source.worker.restore, ["assertCurrent", "readRemoteHead"]);
      }
      instance.admitFactory(source.worker.prepare, [
        "assertCurrent",
        "confirmAdmission",
        "revalidate",
        "readTree",
        "readBlob",
        "prepareGitPack",
      ]);
    }
    state.registry.repositorySources.push(
      state.createRegistration(record, { provider: source, assertCurrent() {} }),
    );
  };
}
