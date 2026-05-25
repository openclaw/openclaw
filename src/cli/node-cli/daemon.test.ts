import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { runNodeDaemonStatus } from "./daemon.js";

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn(async () => null),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "running" })),
  };
  return {
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

vi.mock("../../daemon/runtime-hints.js", () => ({
  buildPlatformRuntimeLogHints: () => [
    "Logs: node service log",
    "Restart attempts: node restart log",
  ],
  buildPlatformServiceStartHints: () => ["openclaw node install", "openclaw node start"],
}));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../daemon-cli/shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon-cli/shared.js")>("../daemon-cli/shared.js");
  return {
    ...actual,
    createCliStatusTextStyles: () => ({
      rich: false,
      label: (text: string) => text,
      accent: (text: string) => text,
      infoText: (text: string) => text,
      okText: (text: string) => text,
      warnText: (text: string) => text,
      errorText: (text: string) => text,
    }),
    formatRuntimeStatus: (runtime: GatewayServiceRuntime | undefined) => runtime?.status ?? "",
    resolveRuntimeStatusColor: () => "",
  };
});

describe("runNodeDaemonStatus", () => {
  function stdout(): string {
    return mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
  }

  function stderr(): string {
    return mocks.runtime.error.mock.calls.map(([line]) => line).join("\n");
  }

  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "running" });
  });

  it("keeps missing service-unit status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service unit not found.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });

  it("keeps stopped status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNodeDaemonStatus();

    const allOutput = runtimeLogs.join("\n");
    expect(allOutput).toContain("openclaw node start");
  });

  it("falls back to a stable runtime status when the service throws on readRuntime", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(async (): Promise<GatewayServiceRuntime> => {
      throw new Error("permission denied");
    });
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: true });

    const payload = defaultRuntime.writeJson.mock.calls[0]?.[0] as {
      service?: { runtime?: Record<string, unknown> };
    };
    expect(payload.service?.runtime?.status).toBe("unknown");
    const detail = payload.service?.runtime?.detail;
    expect(typeof detail === "string" ? detail : "").toContain("permission denied");
  });

  it("emits a service-unit-not-found error to stderr while keeping recovery hints on stdout", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(
      async (): Promise<GatewayServiceRuntime> => ({ status: "running", missingUnit: true }),
    );
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: false });

    // Diagnostic line goes to stderr only (defaultRuntime.error), never stdout.
    expect(runtimeErrors.some((line) => line.includes("Service unit not found"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Service unit not found"))).toBe(false);
    // Recovery hints (log/restart instructions) must go to stdout (defaultRuntime.log)
    // and must not also appear on stderr, so operators piping stderr to /dev/null still
    // see actionable guidance.
    const hintPatterns = [/journalctl/i, /Launchd stdout/i, /Restart attempts/i, /schtasks/i];
    const stdoutText = runtimeLogs.join("\n");
    const stderrText = runtimeErrors.join("\n");
    const matchedHint = hintPatterns.find((rx) => rx.test(stdoutText));
    expect(matchedHint).toBeTruthy();
    if (matchedHint) {
      expect(matchedHint.test(stderrText)).toBe(false);
    }
  });

  it("emits a stopped-runtime error to stderr while keeping recovery hints on stdout", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(async (): Promise<GatewayServiceRuntime> => ({ status: "stopped" }));
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: false });

    expect(runtimeErrors.some((line) => line.includes("not running"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("not running"))).toBe(false);
    const hintPatterns = [/journalctl/i, /Launchd stdout/i, /Restart attempts/i, /schtasks/i];
    const stdoutText = runtimeLogs.join("\n");
    const stderrText = runtimeErrors.join("\n");
    const matchedHint = hintPatterns.find((rx) => rx.test(stdoutText));
    expect(matchedHint).toBeTruthy();
    if (matchedHint) {
      expect(matchedHint.test(stderrText)).toBe(false);
    }
  });
});
