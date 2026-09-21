import { vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

/** Start at the config-flow output contract; state migrations are not this writer's owner. */
export async function prepareWriterContext(configPath: string): Promise<DoctorHealthFlowContext> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error(
      `Writer-order fixture requires a valid initial config: ${JSON.stringify(snapshot.issues)}`,
    );
  }
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = { nonInteractive: true, repair: true };
  const cfg = snapshot.config;
  return {
    runtime,
    options,
    prompter: createDoctorPrompter({ runtime, options }),
    cfg,
    cfgForPersistence: structuredClone(cfg),
    configPath,
    sourceConfigValid: true,
    stateDirExistedAtStart: true,
    configResult: {
      cfg,
      sourceConfigForWrite: snapshot.sourceConfig,
      sourceConfigValid: true,
      sourceLastTouchedVersion: snapshot.sourceConfig.meta?.lastTouchedVersion,
    },
  };
}
