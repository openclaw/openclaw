import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveDoctorUpdateAdmission } from "../commands/doctor-maintenance-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  INSTALLED_GATEWAY_COMMAND_LINE,
  spawnSync,
  spawnSyncResult,
  scheduledTaskProbeResult,
  taskkillPids,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import { killProcessTreeMock } from "./test-helpers/schtasks-fixtures.js";

type GatewayFixture = Parameters<Parameters<typeof withPreparedGatewayTask>[0]>[0];
const taskTest = it.extend<GatewayFixture & { gateway: GatewayFixture }>({
  gateway: async ({ task: _task }, use) => withPreparedGatewayTask(use),
  env: async ({ gateway }, use) => use(gateway.env),
  stdout: async ({ gateway }, use) => use(gateway.stdout),
});

function taskkillCalls() {
  return spawnSync.mock.calls
    .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
    .map(([, args]) => args);
}

const installedGateway = { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE };
const powershellProcess = { ProcessId: 9999, CommandLine: "powershell.exe" };
const snapshotResult = (processes: Array<{ ProcessId: number; CommandLine: string }>) =>
  spawnSyncResult(JSON.stringify(processes));
const tasklistResult = (alive: boolean) =>
  spawnSyncResult(alive ? '"node.exe","4242","Console","1","1 K"' : "No tasks");

function expectNoTermination() {
  expect(taskkillPids()).toEqual([]);
  expect(killProcessTreeMock).not.toHaveBeenCalled();
}
function expectForcedTermination() {
  expect(taskkillCalls()).toEqual([
    ["/T", "/PID", "4242"],
    ["/F", "/T", "/PID", "4242"],
  ]);
}
function expectTasklistProbe() {
  expect(spawnSync.mock.calls).toContainEqual([
    expect.stringMatching(/tasklist\.exe$/i),
    ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
    expect.objectContaining({ timeout: 1_500 }),
  ]);
}

function mockGatewayProcess(
  alive: () => boolean,
  onKill: (forced: boolean) => void,
  snapshot = () => [...(alive() ? [installedGateway] : []), powershellProcess],
  options: { taskProbe?: boolean; closedEnv?: boolean; failGraceful?: boolean } = {},
) {
  spawnSync.mockImplementation((command, args, spawnOptions) => {
    if (options.closedEnv) {
      expect(spawnOptions?.env).toBeDefined();
      expect(spawnOptions?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
    }
    if (options.taskProbe && args?.includes("-EncodedCommand")) {
      return scheduledTaskProbeResult();
    }
    const executable = command.toLowerCase();
    if (executable.endsWith("taskkill.exe")) {
      const forced = args?.includes("/F") ?? false;
      onKill(forced);
      return spawnSyncResult("", options.failGraceful && !forced ? 1 : 0);
    }
    if (executable.endsWith("tasklist.exe")) {
      return tasklistResult(alive());
    }
    return snapshotResult(snapshot());
  });
}

function prepareDoctorAdmission(env: GatewayFixture["env"]) {
  env.OPENCLAW_STATE_DIR = path.join(expectDefined(env.USERPROFILE, "fixture home"), ".openclaw");
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return resolveDoctorUpdateAdmission(env);
}

export {
  expectForcedTermination,
  expectNoTermination,
  expectTasklistProbe,
  installedGateway,
  mockGatewayProcess,
  powershellProcess,
  prepareDoctorAdmission,
  snapshotResult,
  taskTest,
  taskkillCalls,
};
