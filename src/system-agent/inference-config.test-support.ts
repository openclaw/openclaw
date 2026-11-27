import { onTestFinished } from "vitest";
import { createConfigIO } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";

/** Real source and runtime snapshots without replacing the host's state directory. */
export async function createInferenceConfigFixture(config: OpenClawConfig) {
  const state = await createOpenClawTestState({ label: "inference-config", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const io = createConfigIO({
    configPath: state.configPath,
    env: state.env,
    homedir: () => state.home,
    observe: false,
    pluginValidation: "core-only",
  });
  await state.writeConfig(config);
  const snapshot = await io.readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    throw new Error(`Invalid inference fixture config: ${JSON.stringify(snapshot.issues)}`);
  }
  return {
    snapshot,
    read: io.readConfigFileSnapshot,
    write: state.writeConfig,
    preview: (candidate: OpenClawConfig) =>
      io.readConfigFileSnapshotFromRaw(JSON.stringify(candidate)),
  };
}
