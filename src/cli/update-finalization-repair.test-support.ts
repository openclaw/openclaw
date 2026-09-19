import fs from "node:fs/promises";
import path from "node:path";

/** Executable CLI fixture: native service state is shared with the Doctor child. */
export async function prepareRepairDeadlineFixture(
  stubs: Map<string, string>,
  sourceUrl: (relative: string) => string,
  root: string,
  entrypoint: string,
) {
  const statePath = path.join(process.env.OPENCLAW_STATE_DIR!, "managed-service-state");
  await fs.writeFile(statePath, "running");
  const shared = `
import fs from 'node:fs/promises';
const statePath = ${JSON.stringify(statePath)};
const record = event => fs.appendFile(statePath + '.events', event + '\\n');
const env = () => ({ ...process.env });
const command = { programArguments: [process.execPath, ${JSON.stringify(entrypoint)}, 'gateway', '--port', process.env.OPENCLAW_GATEWAY_PORT], environment: env() };
const verdict = { kind: 'owned', root: ${JSON.stringify(root)}, fingerprint: 'fixture-service', refreshDefinition: false };
`;
  const override = (relative: string, code: string) => {
    const url = sourceUrl(relative);
    stubs.set(url, `export * from ${JSON.stringify(`${url}?fixture-original`)};\n${code}`);
  };
  override("../config/paths.ts", "export const isDefaultInstallIdentity = () => true;");
  override(
    "../commands/doctor-service-repair-policy.ts",
    `
export const shouldManageGatewayService = async () => true;
export const isServiceRepairExternallyManaged = () => false;
`,
  );
  override(
    "./update-cli/update-command-service-maintenance.ts",
    `${shared}
export async function maybeStopManagedServiceBeforeMutableUpdate(params) {
  params.assertCurrent?.();
  if (params.phase !== 'inspect') {
    await fs.writeFile(statePath, 'stopped');
    await record('stop');
  }
  const running = (await fs.readFile(statePath, 'utf8')) === 'running';
  return { stopped: params.phase !== 'inspect', inspected: true, runtimeInspected: true,
    running, offline: !running, serviceEnv: env(), serviceUpdateVerdict: verdict };
}
export const revalidateManagedGatewayServiceAfterUpdate = async () => verdict;
`,
  );
  override(
    "../daemon/service.ts",
    `${shared}
const service = {
  readCommand: async () => command,
  restart: async ({assertCurrent}) => {
    assertCurrent();
    await fs.writeFile(statePath, 'running');
    await record('restart');
    return { outcome: 'completed' };
  },
};
export const resolveGatewayService = () => service;
export const readGatewayServiceState = async () => ({ env: env(), command,
  runtime: { status: (await fs.readFile(statePath, 'utf8')) } });
`,
  );
  override(
    "./daemon-cli/restart-health.ts",
    `${shared}
export const waitForGatewayHealthyRestart = async () => ({
  healthy: (await fs.readFile(statePath, 'utf8')) === 'running', staleGatewayPids: [],
  runtime: { status: 'running' }, portUsage: { port: Number(process.env.OPENCLAW_GATEWAY_PORT), status: 'busy', listeners: [], hints: [] },
});
`,
  );
  stubs.delete(sourceUrl("../plugins/plugin-lifecycle-lease.ts"));
  stubs.set(
    sourceUrl("./update-cli/update-command-plugins.ts"),
    `${shared}
import { mutateConfigFileWithRetry } from ${JSON.stringify(sourceUrl("../config/mutate.ts"))};
export async function updatePluginsAfterCoreUpdate(params) {
  await record('plugins-entered');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  try {
    await mutateConfigFileWithRetry({
      writeOptions: { assertCurrent: params.assertCurrent },
      mutate: draft => { draft.update = { channel: 'beta' }; },
    });
    await record('late-write-applied');
  } catch (error) {
    if (!error.message.includes('Update finalization timed out in plugins after 1000ms')) throw error;
    await record('late-write-refused');
    throw error;
  }
  return { status: 'ok', changed: false, warnings: [],
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] }, integrityDrifts: [] };
}
`,
  );
}
