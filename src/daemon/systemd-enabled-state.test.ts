import { afterEach, expect, it, vi } from "vitest";
import * as systemdExec from "./systemd-exec.js";
import { isSystemdServiceEnabled } from "./systemd-runtime.js";
import * as systemdScope from "./systemd-scope.js";

afterEach(() => vi.restoreAllMocks());

it.each(
  ["disabled", "masked", "masked-runtime"].flatMap((state) =>
    (["exit", "timeout", "signal"] as const).map((termination) => ({ state, termination })),
  ),
)(
  "accepts $state output only after a completed is-enabled command ($termination)",
  async ({ state, termination }) => {
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
      stdout: state,
      stderr: state,
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
