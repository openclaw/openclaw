import type {
  ConfigFileSnapshot,
  ConfigSnapshotReadOptions,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../../config/config.js";
import { createConfigReadError, isConfigReadFailure } from "../../config/io.invalid-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { createGatewayCliStartupTrace } from "./startup-trace.js";

export async function readGatewayStartupConfig(
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>,
  readOptions: Pick<ConfigSnapshotReadOptions, "lowerPrecedenceEnv"> = {},
): Promise<{
  cfg: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  startupConfigSnapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult;
}> {
  const { readConfigFileSnapshotWithPluginMetadata } = await import("../../config/config.js");
  const snapshotRead = await startupTrace.measure("cli.config-snapshot", () =>
    readConfigFileSnapshotWithPluginMetadata({ isolateEnv: true, observe: false, ...readOptions }),
  );
  const { snapshot } = snapshotRead;
  if (!snapshot.valid && isConfigReadFailure(snapshot)) {
    throw createConfigReadError(snapshot);
  }
  return {
    cfg: snapshot.config,
    snapshot,
    startupConfigSnapshotRead: snapshotRead,
  };
}
