import { expect, it, type Mock } from "vitest";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { DaemonStatus } from "./status.gather.js";

type SystemdInstallationProbe =
  typeof import("../../daemon/systemd-scope.js").findSystemdGatewayInstallation;

// Registers deep-status systemd / dueling-scope inspection tests. The probe is
// driven via the mocked `findSystemdGatewayInstallation` (vi.mock'd in the host
// test file) so the host can control success / dueling / failure.
export function registerStatusSystemdScanTests(params: {
  gatherStatus: (deep: boolean) => Promise<DaemonStatus>;
  capturePrintedDaemonStatus: (
    status: DaemonStatus,
    opts: { json: boolean; deep?: boolean },
  ) => { logs: string; errors: string };
  findSystemdGatewayInstallation: Mock<SystemdInstallationProbe>;
}) {
  function setSystemdProbe(mode: "none" | "dueling" | "fail") {
    params.findSystemdGatewayInstallation.mockReset();
    if (mode === "dueling") {
      params.findSystemdGatewayInstallation.mockResolvedValue({
        kind: "dueling",
        user: {
          scope: "user",
          unitName: "openclaw-gateway.service",
          unitPath: "/home/test/.config/systemd/user/openclaw-gateway.service",
        },
        system: {
          scope: "system",
          unitName: "openclaw-gateway.service",
          unitPath: "/etc/systemd/system/openclaw-gateway.service",
        },
      });
    } else if (mode === "fail") {
      params.findSystemdGatewayInstallation.mockRejectedValue(
        new Error("systemctl list-units failed"),
      );
    } else {
      params.findSystemdGatewayInstallation.mockResolvedValue({ kind: "none" });
    }
  }

  it("reports dueling systemd diagnosis for its native target", () =>
    withMockedPlatform("linux", async () => {
      setSystemdProbe("dueling");
      const status = await params.gatherStatus(true);
      const printed = params.capturePrintedDaemonStatus(status, { json: false, deep: true });
      const output = `${printed.logs}\n${printed.errors}`;
      expect(output.match(/they will SIGTERM each other/g)).toHaveLength(1);
      expect(output).toContain(status.gateway?.duelingScopesWarning);
      expect(output).toContain("Run `openclaw doctor` interactively");
    }));

  it("surfaces a dueling-scope inspection error when the systemd probe fails", () =>
    withMockedPlatform("linux", async () => {
      setSystemdProbe("fail");
      const status = await params.gatherStatus(true);
      expect(status.gateway?.duelingScopesWarningError).toBeDefined();
      const printed = params.capturePrintedDaemonStatus(status, { json: false, deep: true });
      const output = `${printed.logs}${printed.errors}`;
      expect(output).toContain(status.gateway?.duelingScopesWarningError);
      expect(output).toContain("The dueling-scope diagnosis was NOT checked");
      expect(output).toContain("openclaw doctor");
      expect(output).toContain("for the full check");
    }));
}
