import { expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import { printDaemonStatus } from "./status.print.js";

export function registerServiceInspectionHintTests(params: {
  renderHints: {
    mockImplementation(renderer: (services: readonly ExtraGatewayService[]) => string[]): unknown;
  };
  output: () => string;
}) {
  it.each([
    {
      platform: "linux",
      scope: "user",
      label: "openclaw.service",
      detail: "unit: /home/test/.config/systemd/user/openclaw.service",
      hints: [
        "systemctl --user status -- openclaw.service",
        "systemctl --user cat -- openclaw.service",
      ],
    },
    {
      platform: "linux",
      scope: "system",
      label: "openclaw.service",
      detail: "unit: /etc/systemd/system/openclaw.service",
      hints: [
        "systemctl --system status -- openclaw.service",
        "systemctl --system cat -- openclaw.service",
      ],
    },
    {
      platform: "win32",
      scope: "system",
      label: "\\OpenClaw Node",
      detail: "task: \\OpenClaw Node",
      hints: ['schtasks /Query /TN "\\OpenClaw Node" /V /FO LIST'],
    },
  ] satisfies Array<ExtraGatewayService & { hints: string[] }>)(
    "requires inspection for a detected $scope $platform service",
    async ({ hints, ...service }) => {
      const { renderGatewayServiceCleanupHints } =
        await vi.importActual<typeof import("../../daemon/inspect.js")>("../../daemon/inspect.js");
      params.renderHints.mockImplementation(renderGatewayServiceCleanupHints);

      printDaemonStatus(
        {
          service: {
            label: service.platform === "linux" ? "systemd" : "Scheduled Task",
            loaded: null,
            loadState: { status: "unknown", detail: "ownership not verified" },
            loadedText: "enabled",
            notLoadedText: "disabled",
          },
          extraServices: [service],
        },
        { json: false, deep: true },
      );

      const output = params.output();
      expect(output).toContain(service.label);
      expect(output).not.toContain("disable --now");
      expect(output).not.toContain("rm ");
      expect(output).not.toContain("/Delete");
      for (const hint of hints) {
        expect(output).toContain(`Inspection hint: ${hint}`);
      }
    },
  );
}
