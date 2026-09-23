import { expect, it, vi } from "vitest";
import { printDaemonStatus } from "./status.print.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return { ...actual, colorize: (_rich: boolean, _theme: unknown, text: string) => text };
});

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  resolveRuntimeStatusColor: () => "",
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => [],
}));

it("reports an admitted probe timeout as event-loop saturation instead of failed connectivity", () => {
  printDaemonStatus(
    {
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadState: { status: "loaded" },
        loadedText: "loaded",
        notLoadedText: "not loaded",
        runtime: { status: "running", pid: 8000 },
      },
      rpc: {
        ok: false,
        kind: "read",
        gatewayReached: true,
        timedOut: true,
        error: "gateway timeout after 5000ms",
        eventLoop: {
          degraded: true,
          reasons: ["event_loop_delay", "event_loop_utilization"],
          intervalMs: 5_000,
          delayP99Ms: 5_079,
          delayMaxMs: 5_100,
          utilization: 1,
          cpuCoreRatio: 0.94,
        },
      },
      health: { healthy: true, staleGatewayPids: [] },
      extraServices: [],
    },
    { json: false, deep: true },
  );

  const errors = runtime.error.mock.calls.flat().join("\n");
  const logs = runtime.log.mock.calls.flat().join("\n");
  expect(errors).toContain("Read probe: timed out under event-loop load");
  expect(errors).toContain("Gateway event loop: degraded max=5100ms p99=5079ms util=1 cpu=0.94");
  expect(logs).toContain("Gateway accepted the connection");
  expect(errors).not.toContain("Connectivity probe: failed");
  expect(logs).not.toContain("not a warm-up delay");
});
