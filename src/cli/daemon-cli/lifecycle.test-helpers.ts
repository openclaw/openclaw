import { expect, it, vi, type Mock } from "vitest";

type RestartPostCheckContext = {
  activationAccepted: boolean;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

export type RestartParams = {
  opts?: { json?: boolean };
  beforeServiceMutation?: () => void;
  repairLoadedService?: (ctx: {
    json: boolean;
    stdout: NodeJS.WritableStream;
    state: unknown;
    issues: unknown[];
  }) => Promise<unknown>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

export function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

export async function expectRestartError(
  promise: Promise<unknown>,
): Promise<Error & { hints?: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hints?: string[] };
  }
  throw new Error("expected restart to fail");
}

export function registerDisabledSystemdStopTests({
  service,
  findInstalledSystemdGatewayScope,
  findVerifiedGatewayListenerPidsOnPortSync,
  runUnmanagedStop,
}: {
  service: { readRuntime: Mock; readCommand: Mock; stop: Mock };
  findInstalledSystemdGatewayScope: Mock;
  findVerifiedGatewayListenerPidsOnPortSync: Mock;
  runUnmanagedStop: (options?: { force?: boolean }) => Promise<unknown>;
}) {
  it("stops a running disabled systemd unit through the service manager", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await runUnmanagedStop();

    expect(service.stop).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env, stdout: process.stdout }),
    );
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it.each(["inactive", "failed"])(
    "stops an installed disabled %s systemd unit to cancel its recovery scope",
    async (state) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      service.readRuntime.mockResolvedValue({ status: "stopped", state });
      findInstalledSystemdGatewayScope.mockResolvedValue({
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/synthetic/.config/systemd/user/openclaw-gateway.service",
      });

      await runUnmanagedStop({ force: true });

      expect(service.stop).toHaveBeenCalledOnce();
      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "missing", "foreign"])(
    "does not route a disabled %s unit through the native stop path",
    async (kind) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      service.readRuntime.mockResolvedValue({
        status: kind === "unknown" ? "unknown" : "stopped",
        state: "inactive",
        missingUnit: kind === "missing",
      });
      findInstalledSystemdGatewayScope.mockResolvedValue({
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/tmp/synthetic/gateway.service",
      });
      if (kind === "foreign") {
        service.readCommand.mockResolvedValue({
          programArguments: ["foreign-service"],
          environment: {},
        });
      }
      await runUnmanagedStop({ force: true });
      expect(service.stop).not.toHaveBeenCalled();
    },
  );
}
