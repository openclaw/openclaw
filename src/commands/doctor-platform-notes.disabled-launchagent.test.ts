import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execLaunchctl } from "../daemon/launchd-exec.js";
import { runGatewayDaemonHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-contributions.test-support.js";

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

describe("Doctor disabled LaunchAgent diagnosis", () => {
  let home: string;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-launchagent-"));
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  });

  afterEach(async () => {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([
    {
      label: "ai.openclaw.gateway",
      override: undefined,
      command: "openclaw gateway start",
    },
    {
      label: "dev.openclaw.custom",
      override: "dev.openclaw.custom",
      command: "OPENCLAW_LAUNCHD_LABEL=dev.openclaw.custom openclaw gateway start",
    },
  ])(
    "diagnoses $label during offline repair without activating it",
    async ({ label, override, command }) => {
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_CONFIG_PATH: path.join(home, "state", "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: override,
      };
      await fs.mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
      await fs.writeFile(path.join(home, "Library", "LaunchAgents", `${label}.plist`), "fixture");
      vi.mocked(execLaunchctl).mockImplementation(async ([action, target]) => {
        if (action === "print" && target?.endsWith(`/${label}`)) {
          return { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
        }
        if (action === "print-disabled") {
          return { code: 0, stdout: `"${label}" => disabled`, stderr: "", termination: "exit" };
        }
        throw new Error(`Unexpected launchctl action: ${action}`);
      });
      const ctx = createDoctorHealthFlowContext({
        env,
        options: { repair: true, nonInteractive: true },
        gatewayMaintenanceActive: true,
      });

      await runGatewayDaemonHealth(ctx);

      expect(note).toHaveBeenCalledOnce();
      const message = note.mock.calls[0]?.[0];
      expect(message).toContain(
        `Gateway LaunchAgent ${label} is installed but unloaded and disabled`,
      );
      expect(message).toContain(command);
      expect(message).toContain("update");
      expect(message).toContain("doctor");
      expect(message).toContain("triage");
      expect(maybeRepairGatewayDaemon).not.toHaveBeenCalled();
      expect(execLaunchctl).toHaveBeenCalledTimes(2);
    },
  );

  it("leaves an installed and enabled service unchanged", async () => {
    const label = "dev.openclaw.other-state";
    const env = { HOME: home, OPENCLAW_LAUNCHD_LABEL: label };
    await fs.mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    await fs.writeFile(path.join(home, "Library", "LaunchAgents", `${label}.plist`), "fixture");
    vi.mocked(execLaunchctl).mockImplementation(async ([action]) => {
      if (action === "print") {
        return {
          code: 113,
          stdout: "",
          stderr: "Could not find service",
          termination: "exit",
        };
      }
      if (action === "print-disabled") {
        return {
          code: 0,
          stdout: `"${label}" => enabled`,
          stderr: "",
          termination: "exit",
        };
      }
      throw new Error(`Unexpected launchctl action: ${action}`);
    });
    const ctx = createDoctorHealthFlowContext({ env, healthOk: true });

    await runGatewayDaemonHealth(ctx);

    expect(note).not.toHaveBeenCalled();
    expect(maybeRepairGatewayDaemon).toHaveBeenCalledOnce();
  });
});
