import { vi } from "vitest";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

export async function prepareDoctorContext(
  configPath: string,
  params: {
    options?: DoctorOptions;
    confirm?: Parameters<typeof loadAndMaybeMigrateDoctorConfig>[0]["confirm"];
  } = {},
): Promise<DoctorHealthFlowContext> {
  const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const options: DoctorOptions = params.options ?? { nonInteractive: true, repair: true };
  const prompter = createDoctorPrompter({ runtime, options });
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: params.confirm ?? ((confirmation) => prompter.confirm(confirmation)),
    runtime,
    prompter,
  });
  return {
    runtime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath,
    stateDirExistedAtStart: true,
    runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
    invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
  };
}
