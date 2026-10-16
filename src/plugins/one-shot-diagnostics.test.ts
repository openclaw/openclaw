import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginServicesHandle } from "./services.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const acquirePluginRegistryForInspection = vi.hoisted(() => vi.fn());
const startPluginServices = vi.hoisted(() => vi.fn());
const waitForDiagnosticEventsDrained = vi.hoisted(() => vi.fn(async () => {}));
const warn = vi.hoisted(() => vi.fn());

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
const start = (config = otelEnabledConfig, suppressStdoutDiagnosticLogs = false) =>
  host.start({ config, suppressStdoutDiagnosticLogs });

const otelEnabledConfig: OpenClawConfig = {
  diagnostics: { otel: { enabled: true, endpoint: "http://127.0.0.1:4318" } },
};

function mockRegistry(
  service: OpenClawPluginService = { id: "diagnostics-otel", start() {} },
  origin: "bundled" | "workspace" = "bundled",
) {
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "diagnostics-otel",
    id: service.id.trim(),
    service,
    source: "test",
    origin,
  });
  acquirePluginRegistryForInspection.mockResolvedValue({
    registry,
    release: vi.fn(async () => {}),
  });
}
async function mockRealExporter(service: OpenClawPluginService, origin: "bundled" | "workspace") {
  const { startPluginServices: startRealServices } =
    await vi.importActual<typeof import("./services.js")>("./services.js");
  mockRegistry(service, origin);
  let servicesHandle: PluginServicesHandle | undefined;
  startPluginServices.mockImplementationOnce(
    async (params: Parameters<typeof startRealServices>[0]) => {
      servicesHandle = await startRealServices(params);
      return servicesHandle;
    },
  );
  return { stop: () => servicesHandle?.stop() };
}

beforeEach(() => {
  host = createOneShotDiagnosticsTestHost();
  vi.clearAllMocks();
  waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
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
  await mockRealExporter({ id: "diagnostics-otel", start() {}, stop() {} }, "workspace");
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
    mockRegistry();
    startPluginServices.mockResolvedValue({ stop: vi.fn(async () => {}) });
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
  const services = await mockRealExporter(
    { id: "diagnostics-otel", start: () => {}, stop: exporterStop },
    "bundled",
  );
  waitForDiagnosticEventsDrained.mockRejectedValue(new Error("event drain failed"));
  try {
    const handle = await start();
    await expect(handle?.stop()).resolves.toBeUndefined();
    expect(exporterStop).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/one-shot diagnostics .*event drain failed/),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/one-shot diagnostics .*exporter shutdown failed/),
    );
  } finally {
    await Promise.allSettled([services.stop()]);
  }
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
    const services = await mockRealExporter(
      {
        id: "diagnostics-otel",
        start: (context) => {
          internalDiagnostics = context.internalDiagnostics;
        },
        stop: exporterStop,
      },
      origin,
    );
    waitForDiagnosticEventsDrained.mockImplementation(() => drain.promise);
    let stopping: Promise<void> | undefined;
    const stopped = vi.fn<() => void>();
    vi.useFakeTimers();
    try {
      const handle = await start();
      expect(handle).not.toBeNull();
      expect(Boolean(internalDiagnostics)).toBe(origin === "bundled");
      stopping = handle?.stop().then(stopped);
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
    } finally {
      drain.resolve();
      flush.resolve();
      try {
        await vi.advanceTimersByTimeAsync(0);
        await stopping;
        await services.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it("warns when otel is configured but the diagnostics-otel plugin is absent", async () => {
  mockRegistry({ id: "other-service", start() {} });

  const handle = await start();

  expect(handle).toBeNull();
  expect(startPluginServices).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("diagnostics-otel plugin is not"));
});
