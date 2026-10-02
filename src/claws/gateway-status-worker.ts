import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-record-reader.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { projectClawsStatus } from "./gateway-status-projection.js";
import { readClawInventory } from "./inventory-read.js";
import { readClawStatus } from "./lifecycle-status.js";

export async function readClawStatusRecordsForGateway(input: {
  config: OpenClawConfig;
  target?: string;
  exactAgentId?: boolean;
}) {
  const context = captureOpenClawStateReadWorkerContext();
  const path = context.admission.databasePath;
  const inventory = await readClawInventory(
    { path, env: context.environment },
    { context, current: true },
  );
  context.admission.assertCurrent();

  let sourceMcpServers: Record<string, Record<string, unknown>> = {};
  if (inventory.mcpServers.length > 0) {
    const listed = await listConfiguredMcpServers();
    context.admission.assertCurrent();
    if (!listed.ok) {
      throw new Error("Claw MCP source config is unavailable.");
    }
    sourceMcpServers = listed.mcpServers;
  }

  if (inventory.packages.some((pkg) => pkg.kind === "plugin")) {
    clearLoadInstalledPluginIndexInstallRecordsCache();
  }

  const status = await readClawStatus(input.target, {
    path,
    env: context.environment,
    config: input.config,
    sourceMcpServers,
    inventory,
    readOnly: true,
    ...(input.exactAgentId ? { exactAgentId: true } : {}),
    packageDeps: {
      resolvePlugin: async ({ clawhubPackage }) =>
        await resolveInstalledClawHubPlugin({
          clawhubPackage,
          loadInstallRecords: async () =>
            await loadInstalledPluginIndexInstallRecords({
              filePath: path,
              stateDir: resolveOpenClawStateDirForDatabasePath(path),
              env: context.environment,
              artifactPreservingReadOnly: true,
            }),
        }),
    },
  });
  context.admission.assertCurrent();
  return { records: status.records, assertCurrent: () => context.admission.assertCurrent() };
}

export async function readClawStatusForGateway(input: {
  config: OpenClawConfig;
  target?: string;
  listCronJobs?: () => Promise<readonly CronJob[]>;
}) {
  const { records, assertCurrent } = await readClawStatusRecordsForGateway(input);

  let cronJobs: readonly CronJob[] | undefined;
  if (records.some((record) => record.cronJobs.length > 0) && input.listCronJobs) {
    try {
      cronJobs = await input.listCronJobs();
    } catch {
      // A missing scheduler inventory cannot prove a job healthy.
    }
    assertCurrent();
  }
  return projectClawsStatus(records, cronJobs);
}
