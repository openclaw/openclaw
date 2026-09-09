/** Starts diagnostics exporter plugin services for one-shot CLI embedded agent runs. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../shared/async-work-scope.js";

const log = createSubsystemLogger("plugins");

// Only push-based exporters that can flush before a short-lived process exits.
// diagnostics-prometheus is pull-based (scrape server) and would bind a port
// that races the gateway on the same host, so it stays gateway-only.
const ONE_SHOT_DIAGNOSTICS_SERVICE_IDS = new Set(["diagnostics-otel"]);
// Separate drain and flush waits preserve buffered telemetry after a stalled drain.
// These limits do not cancel exporter-owned work or replace its network request timeout.
const ONE_SHOT_DIAGNOSTICS_DRAIN_TIMEOUT_MS = 5_000;
const ONE_SHOT_DIAGNOSTICS_FLUSH_TIMEOUT_MS = 10_000;

export type OneShotDiagnosticsHandle = {
  stop: () => Promise<void>;
};

function suppressOtelStdoutLogSink(config: OpenClawConfig): OpenClawConfig {
  const diagnostics = config.diagnostics;
  const otel = diagnostics?.otel;
  if (otel?.logs !== true || (otel.logsExporter !== "stdout" && otel.logsExporter !== "both")) {
    return config;
  }
  // JSON-mode agent CLI stdout is machine-readable output. The OTel stdout
  // log sink writes directly to process.stdout, so suppress only that sink for
  // one-shot exporters while preserving OTLP diagnostics where configured.
  return {
    ...config,
    diagnostics: {
      ...diagnostics,
      otel: {
        ...otel,
        logs: otel.logsExporter === "both",
        logsExporter: "otlp",
      },
    },
  };
}

function isOtelExportConfigured(config: OpenClawConfig): boolean {
  // Mirrors the diagnostics-otel service's own start() gate so disabled
  // configs skip plugin loading entirely on the CLI hot path.
  const diagnostics = config.diagnostics;
  return Boolean(diagnostics && diagnostics.enabled !== false && diagnostics.otel?.enabled);
}

/**
 * Start the diagnostics OTel exporter for a one-shot embedded agent run.
 *
 * Gateway processes start diagnostics exporters via startPluginServices at
 * startup; one-shot `openclaw agent --local` runs execute the agent in the CLI
 * process where no plugin service ever starts, so diagnostic events had no OTel
 * subscriber and spans were dropped.
 * Returns null when OTel export is not configured or the plugin is not
 * enabled/installed; the returned handle's stop() drains the diagnostic event
 * queue and shuts the SDK down (force-flush) before the process exits.
 */
export async function startOneShotDiagnosticsExporters(params: {
  config: OpenClawConfig;
  suppressStdoutDiagnosticLogs?: boolean;
}): Promise<OneShotDiagnosticsHandle | null> {
  const config =
    params.suppressStdoutDiagnosticLogs === true
      ? suppressOtelStdoutLogSink(params.config)
      : params.config;
  if (!isOtelExportConfigured(config)) {
    return null;
  }
  const [{ acquirePluginRegistryForInspection }, { startPluginServices }] = await Promise.all([
    import("./loader.js"),
    import("./services.js"),
  ]);
  // Scoped, non-activating load: honors the same plugin enablement config as
  // the gateway's startup load without replacing the active runtime registry
  // the embedded run resolves providers/tools from.
  const acquired = await acquirePluginRegistryForInspection({
    config,
    onlyPluginIds: [...ONE_SHOT_DIAGNOSTICS_SERVICE_IDS],
    preferBuiltPluginArtifacts: true,
  });
  const work = new AsyncWorkScope();
  let servicesHandle: Awaited<ReturnType<typeof startPluginServices>> | undefined;
  let shutdown: { stopping: Promise<void>; released: Promise<void> } | undefined;
  const reportShutdownFailure = (error: unknown) => {
    for (const failure of error instanceof AggregateError ? error.errors : [error]) {
      log.warn(`one-shot diagnostics shutdown failed: ${String(failure)}`);
    }
  };
  const release = async () => {
    await work.drain();
    await acquired.release();
  };
  const stop = () => {
    // Every caller retains physical cleanup, including callers after a bounded stop settled.
    const trackCaller = captureAsyncWorkTracker();
    if (!shutdown) {
      const stopping = work.track(async () => {
        try {
          await servicesHandle?.stop();
        } catch (error) {
          reportShutdownFailure(error);
        }
      });
      // Cleanup must run even if a retained callback restores a closed caller scope.
      const released = stopping.then(release, release).catch(reportShutdownFailure);
      shutdown = { stopping, released };
    }
    const { stopping, released } = shutdown;
    void trackCaller(() => released).catch(reportShutdownFailure);
    return stopping;
  };
  try {
    // The scope-piggyback loader rules (e.g. dreaming sidecars) can widen a
    // scoped load, so re-filter to the flush-safe exporter allowlist.
    const services = acquired.registry.services.filter((entry) =>
      ONE_SHOT_DIAGNOSTICS_SERVICE_IDS.has(entry.service.id),
    );
    if (services.length === 0) {
      // Enabled but not installed is ordinary; explain why this run exports nothing.
      log.warn(
        "diagnostics.otel is enabled but the diagnostics-otel plugin is not installed or not enabled; this run exports no telemetry.",
      );
      await release().catch(reportShutdownFailure);
      return null;
    }
    servicesHandle = await work.track(() =>
      startPluginServices({
        registry: { ...acquired.registry, services },
        config,
        oneShotStopTimeouts: {
          eventDrainMs: ONE_SHOT_DIAGNOSTICS_DRAIN_TIMEOUT_MS,
          serviceStopMs: ONE_SHOT_DIAGNOSTICS_FLUSH_TIMEOUT_MS,
        },
        onHandle: (handle) => {
          servicesHandle = handle;
        },
      }),
    );
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
