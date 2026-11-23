import { expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import { printDaemonStatus } from "./status.print.js";

export function registerServiceInspectionHintTests(params: {
  renderHints: {
    mockImplementation(renderer: (services: readonly ExtraGatewayService[]) => string[]): unknown;
  };
  output: () => string;
  errors: () => string;
  jsonValue: () => unknown;
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

  it("labels sole-action recovery deletion as cleanup and keeps inspection failures visible", async () => {
    const { renderGatewayServiceCleanupHints } =
      await vi.importActual<typeof import("../../daemon/inspect.js")>("../../daemon/inspect.js");
    params.renderHints.mockImplementation(renderGatewayServiceCleanupHints);
    const label = "\\OpenClaw Gateway Example";
    const status = {
      service: {
        label: "Scheduled Task",
        loaded: null,
        loadState: { status: "unknown", detail: "ownership not verified" },
        loadedText: "enabled",
        notLoadedText: "disabled",
      },
      extraServices: [
        {
          platform: "win32",
          scope: "system",
          label,
          detail: "missing recovery launcher: C:\\missing\\openclaw-gateway-recovery.exe",
          windowsMissingRecoveryLauncher: "C:\\missing\\openclaw-gateway-recovery.exe",
        },
      ],
      extraServiceInspectionErrors: [
        {
          source: "\\OpenClaw Gateway Unreadable",
          message: "Gateway recovery launcher could not be inspected.",
        },
      ],
    } as Parameters<typeof printDaemonStatus>[0];
    printDaemonStatus(status, { json: false, deep: true });

    const output = params.output();
    expect(output).toContain(`Inspection hint: schtasks /Query /TN "${label}" /V /FO LIST`);
    expect(output).toContain(`Cleanup hint: schtasks /Delete /F /TN "${label}"`);
    expect(output).not.toContain("Inspection hint: schtasks /Delete");
    expect(params.errors()).toContain("Gateway service inspection failed:");
    expect(params.errors()).toContain(
      "- \\OpenClaw Gateway Unreadable: Gateway recovery launcher could not be inspected.",
    );
    expect(output).not.toContain('schtasks /Delete /F /TN "\\OpenClaw Gateway Unreadable"');
    expect(params.errors()).not.toContain(
      'schtasks /Delete /F /TN "\\OpenClaw Gateway Unreadable"',
    );

    printDaemonStatus(status, { json: true, deep: true });
    expect(params.jsonValue()).toMatchObject({
      extraServiceInspectionErrors: status.extraServiceInspectionErrors,
    });
  });
}
