import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execLaunchctl } from "../daemon/launchd-exec.js";
import { runGatewayDaemonHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-contributions.test-support.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { note, maybeRepairGatewayDaemon } = vi.hoisted(() => ({
  note: vi.fn(),
  maybeRepairGatewayDaemon: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("./doctor-gateway-daemon-flow.js", () => ({ maybeRepairGatewayDaemon }));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  home = tempDirs.make("openclaw-doctor-launchagent-");
  mockProcessPlatform("darwin");
});

afterEach(() => vi.restoreAllMocks());

async function install(label: string, disabled: boolean) {
  const directory = path.join(home, "Library", "LaunchAgents");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${label}.plist`), "fixture");
  vi.mocked(execLaunchctl).mockImplementation(async ([action, target]) => {
    const result = { code: 0, stdout: "", stderr: "", termination: "exit" as const };
    if (action === "print" && target?.endsWith(`/${label}`)) {
      return { ...result, code: 113, stderr: "Could not find service" };
    }
    if (action === "print-disabled") {
      return { ...result, stdout: `"${label}" => ${disabled ? "disabled" : "enabled"}` };
    }
    throw new Error(`Unexpected launchctl action: ${action}`);
  });
  return { HOME: home, OPENCLAW_LAUNCHD_LABEL: label };
}

it.each([
  [undefined, "openclaw gateway start"],
  ["dev.openclaw.custom", "OPENCLAW_LAUNCHD_LABEL=dev.openclaw.custom openclaw gateway start"],
])("diagnoses disabled %s without activation", async (override, command) => {
  const label = override ?? "ai.openclaw.gateway";
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: path.join(home, "state", "openclaw.json"),
    OPENCLAW_LAUNCHD_LABEL: override,
  };
  await install(label, true);
  const ctx = createDoctorHealthFlowContext({
    env,
    options: { repair: true, nonInteractive: true },
    gatewayMaintenanceActive: true,
  });

  await runGatewayDaemonHealth(ctx);

  expect(note).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(`Gateway LaunchAgent ${label} is installed but unloaded and disabled`),
    expect.anything(),
  );
  for (const text of [command, "update", "doctor", "triage"]) {
    expect(note.mock.calls[0]?.[0]).toContain(text);
  }
  expect(maybeRepairGatewayDaemon).not.toHaveBeenCalled();
  expect(execLaunchctl).toHaveBeenCalledTimes(2);
});

it("leaves an installed and enabled service unchanged", async () => {
  const env = await install("dev.openclaw.other-state", false);
  const ctx = createDoctorHealthFlowContext({ env, healthOk: true });

  await runGatewayDaemonHealth(ctx);

  expect(note).not.toHaveBeenCalled();
  expect(maybeRepairGatewayDaemon).toHaveBeenCalledOnce();
});
