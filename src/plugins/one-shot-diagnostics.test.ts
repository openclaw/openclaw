import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const acquirePluginRegistryForInspection = vi.hoisted(() => vi.fn());
const startPluginServices = vi.hoisted(() => vi.fn());
const waitForDiagnosticEventsDrained = vi.hoisted(() => vi.fn(async () => {}));
const warn = vi.hoisted(() => vi.fn());
const exporterId = "diagnostics-otel";

vi.mock("./loader.js", () => ({ acquirePluginRegistryForInspection }));
vi.mock("./services.js", () => ({ startPluginServices }));
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/diagnostic-events.js")>()),
  waitForDiagnosticEventsDrained,
}));

import { startOneShotDiagnosticsExporters as startWithoutHost } from "./one-shot-diagnostics.js";
import { createOneShotDiagnosticsTestHost } from "./one-shot-diagnostics.test-support.js";

let host: ReturnType<typeof createOneShotDiagnosticsTestHost>;
let cleanups: (() => unknown)[];
const start = (config = otelEnabledConfig, suppressStdoutDiagnosticLogs = false) =>
  host.start({ config, suppressStdoutDiagnosticLogs });

const otelEnabledConfig: OpenClawConfig = { diagnostics: { otel: { enabled: true } } };

async function mockExporter(
  overrides: Partial<OpenClawPluginService> = {},
  origin: "bundled" | "workspace" = "bundled",
  real = false,
) {
  const service: OpenClawPluginService = { id: exporterId, start() {}, ...overrides };
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: service.id,
    id: service.id.trim(),
    service,
    source: "test",
    origin,
  });
  acquirePluginRegistryForInspection.mockResolvedValue({ registry, release: async () => {} });
  if (!real) {
    startPluginServices.mockResolvedValue({ stop: vi.fn(async () => {}) });
    return;
  }
  const { startPluginServices: startRealServices } =
    await vi.importActual<typeof import("./services.js")>("./services.js");
  startPluginServices.mockImplementationOnce(
    async (params: Parameters<typeof startRealServices>[0]) => {
      const servicesHandle = await startRealServices(params);
      cleanups.unshift(() => servicesHandle.stop());
      return servicesHandle;
    },
  );
}

beforeEach(() => {
  host = createOneShotDiagnosticsTestHost();
  cleanups = [];
  vi.clearAllMocks();
  waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup();
    }
  } finally {
    vi.useRealTimers();
  }
});

it("requires an existing host for enabled export before loading plugins", async () => {
  await expect(startWithoutHost({ config: otelEnabledConfig })).rejects.toThrow(
    "One-shot diagnostics requires a bound SDK host scheduler",
  );
  expect(acquirePluginRegistryForInspection).not.toHaveBeenCalled();
});

it("retires the exporter service without stopping its host's sibling work", async () => {
  const peer = vi.fn();
  host.scheduler.schedule({ id: "peer", delayMs: 1, run: peer });
  await mockExporter({ stop() {} }, "workspace", true);
  const handle = await start();
  expect(handle).not.toBeNull();
  await handle?.stop();
  expect(host.scheduler.signal.aborted).toBe(false);
  await host.clock.advanceBy(1);
  expect(peer).toHaveBeenCalledOnce();
});

it.each([
  ["no diagnostics config", {}],
  ["no otel config", { diagnostics: {} }],
  ["diagnostics disabled", { diagnostics: { enabled: false, otel: { enabled: true } } }],
  ["otel disabled", { diagnostics: { otel: { enabled: false } } }],
])("skips plugin loading when otel export is not configured (%s)", async (_label, config) => {
  const handle = await startWithoutHost({ config: config as OpenClawConfig });

  expect(handle).toBeNull();
  expect(acquirePluginRegistryForInspection).not.toHaveBeenCalled();
  expect(startPluginServices).not.toHaveBeenCalled();
});

it.each([
  { logsExporter: "both", logs: true },
  { logsExporter: "stdout", logs: false },
] as const)(
  "suppresses $logsExporter stdout logs without changing caller config",
  async ({ logsExporter, logs }) => {
    const config: OpenClawConfig = {
      diagnostics: { otel: { enabled: true, logs: true, logsExporter } },
    };
    await mockExporter();
    const handle = await start(config, true);
    expect(handle).not.toBeNull();
    const startParams = startPluginServices.mock.calls[0]?.[0] as { config: OpenClawConfig };
    expect(startParams.config.diagnostics?.otel).toMatchObject({ logs, logsExporter: "otlp" });
    expect(config.diagnostics?.otel?.logsExporter).toBe(logsExporter);
  },
);

it("reports drain and exporter failures without failing the CLI shutdown", async () => {
  const exporterStop = vi.fn(() => {
    throw new Error("exporter shutdown failed");
  });
  await mockExporter({ stop: exporterStop }, "bundled", true);
  waitForDiagnosticEventsDrained.mockRejectedValue(new Error("event drain failed"));
  const handle = await start();
  await expect(handle?.stop()).resolves.toBeUndefined();
  expect(exporterStop).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/one-shot diagnostics .*event drain failed/),
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/one-shot diagnostics .*exporter shutdown failed/),
  );
});

it.each([
  { drainOutcome: "immediate completion", drainWaitMs: 0, origin: "bundled" },
  { drainOutcome: "early completion", drainWaitMs: 2_000, origin: "bundled" },
  { drainOutcome: "timeout", drainWaitMs: 5_000, origin: "bundled" },
  { drainOutcome: "timeout", drainWaitMs: 5_000, origin: "workspace" },
] as const)(
  "gives the $origin exporter a separate flush window after drain $drainOutcome",
  async ({ drainWaitMs, origin }) => {
    const drain = createDeferredCore();
    const flush = createDeferredCore();
    const exporterStop = vi.fn(() => flush.promise);
    let internalDiagnostics: OpenClawPluginServiceContext["internalDiagnostics"];
    await mockExporter(
      {
        start: (context) => {
          internalDiagnostics = context.internalDiagnostics;
        },
        stop: exporterStop,
      },
      origin,
      true,
    );
    waitForDiagnosticEventsDrained.mockImplementation(() => drain.promise);
    const stopped = vi.fn<() => void>();
    vi.useFakeTimers();
    cleanups.push(async () => {
      drain.resolve();
      flush.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    const handle = await start();
    expect(handle).not.toBeNull();
    expect(Boolean(internalDiagnostics)).toBe(origin === "bundled");
    const stopping = handle?.stop().then(stopped);
    if (drainWaitMs > 0) {
      await vi.advanceTimersByTimeAsync(drainWaitMs - 1);
      expect(exporterStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    if (drainWaitMs < 5_000) {
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }

    // Observe the exporter itself: a service-manager stop can still be waiting on another drain.
    expect(exporterStop).toHaveBeenCalledOnce();
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
    if (internalDiagnostics) {
      expect(internalDiagnostics.getRuntimeIdentity).toThrow("no longer active");
    }
  },
);

it("warns when otel is configured but the diagnostics-otel plugin is absent", async () => {
  await mockExporter({ id: "other-service" });

  const handle = await start();

  expect(handle).toBeNull();
  expect(startPluginServices).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("diagnostics-otel plugin is not"));
});
