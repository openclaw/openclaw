import { afterEach, expect, it, vi } from "vitest";
import * as systemdExec from "./systemd-exec.js";
import { isSystemdServiceEnabled } from "./systemd-runtime.js";
import * as systemdScope from "./systemd-scope.js";

afterEach(() => vi.restoreAllMocks());

it.each(["exit", "timeout", "signal"] as const)(
  "accepts disabled output only after a completed is-enabled command (%s)",
  async (termination) => {
    const env = { HOME: "/synthetic/systemd-enabled" };
    const unitName = "openclaw-gateway.service";
    vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockResolvedValue({
      scope: "user",
      unitName,
      unitPath: `${env.HOME}/.config/systemd/user/${unitName}`,
    });
    const execute = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue({
      code: 1,
      termination,
      stdout: "disabled",
      stderr: "disabled",
    });

    const result = isSystemdServiceEnabled({ env });
    if (termination === "exit") {
      await expect(result).resolves.toBe(false);
    } else if (termination === "timeout") {
      await expect(result).rejects.toMatchObject({
        reason: "systemd-inspection-deadline-exceeded",
      });
    } else {
      await expect(result).rejects.toThrow("systemctl is-enabled unavailable:");
    }
    expect(execute).toHaveBeenCalledExactlyOnceWith(env, ["is-enabled", unitName], undefined);
  },
);
