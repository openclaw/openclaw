import { expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import { defaultRuntime } from "../../runtime.js";
import { printDaemonStatus } from "./status.print.js";

export function registerServiceInspectionHintTests(params: {
  renderHints: {
    mockImplementation(renderer: (services: readonly ExtraGatewayService[]) => string[]): unknown;
  };
  output: () => string;
}) {
  it("prints Windows launcher parse details without a classified inspection reason", () => {
    printDaemonStatus(
      {
        service: {
          label: "Scheduled Task",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "registered",
          notLoadedText: "missing",
          runtime: {
            status: "unknown",
            inspectionFailure: {
              code: "service-runtime-inspection-failed",
              detail: "Launcher line 4: invalid environment assignment.",
            },
          },
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Launcher line 4: invalid environment assignment."),
    );
  });

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
