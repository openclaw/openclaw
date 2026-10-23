// Captures validated source config and write ownership for plugin lifecycle operations.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  type ConfigFileSnapshot,
} from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-config-mutation.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";

function readValidSourceConfig(snapshot: ConfigFileSnapshot) {
  if (!snapshot.valid) {
    throw new ManagedPluginLifecycleError(
      "Config invalid; run `openclaw doctor --fix` before managing plugins.",
    );
  }
  return snapshot.sourceConfig;
}

export async function readPluginRuntimeConfig() {
  return readValidSourceConfig(await readConfigFileSnapshot({ observe: false, isolateEnv: true }));
}

export async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
  beforePersistentApply?: () => void,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const config = readValidSourceConfig(snapshot);
  const mutationWriteOptions = selectInstallMutationWriteOptions(
    writeOptions,
    beforePersistentApply,
  );
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: asRecord(snapshot.parsed),
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (pluginMutation.mode === "blocked") {
    throw new ManagedPluginLifecycleError(pluginMutation.reason);
  }
  return {
    config,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
  };
}
