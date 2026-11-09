import { vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { RuntimeEnv } from "../runtime.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  createDoctorPrompter,
  type DoctorOptions,
  type DoctorPrompter,
} from "./doctor-prompter.js";

export async function withDoctorConfigMaintenance<T>(run: () => Promise<T>): Promise<T> {
  const database = openOpenClawStateDatabase();
  const owner = acquireGatewayStateOwner({ databasePath: database.path });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  try {
    return await maintenance.run(run);
  } finally {
    await maintenance.close();
    owner.release();
  }
}

export async function prepareDoctorContext(
  configPath: string,
  params: {
    options?: DoctorOptions;
    confirm?: Parameters<typeof loadAndMaybeMigrateDoctorConfig>[0]["confirm"];
    prompter?: DoctorPrompter;
  } = {},
): Promise<DoctorHealthFlowContext & AsyncDisposable> {
  const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const options: DoctorOptions = params.options ?? { nonInteractive: true, repair: true };
  const prompter = params.prompter ?? createDoctorPrompter({ runtime, options });
  const publishedBefore = getRuntimeConfigSnapshot() !== null;
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: params.confirm ?? ((confirmation) => prompter.confirm(confirmation)),
    runtime,
    prompter,
  });
  return {
    [Symbol.asyncDispose]: async () => {
      await configResult[Symbol.asyncDispose]();
      if (!publishedBefore) {
        clearRuntimeConfigSnapshot();
      }
    },
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
