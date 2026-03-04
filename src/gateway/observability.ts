import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { NodeSDK } from "@opentelemetry/sdk-node";

// Configurable via env vars
const METRICS_PORT = parseInt(process.env.OTEL_METRICS_PORT || "9464", 10);

// Set service name via env var to avoid explicit Resource class usage issues with some bundlers
if (!process.env.OTEL_SERVICE_NAME) {
  process.env.OTEL_SERVICE_NAME = "moltbot-gateway";
}

let sdk: NodeSDK | null = null;

export function initObservability() {
  if (process.env.DISABLE_OBSERVABILITY === "true") {
    return;
  }

  const exporter = new PrometheusExporter({
    port: METRICS_PORT,
    endpoint: "/metrics",
  });

  sdk = new NodeSDK({
    metricReader: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy instrumentations if needed
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    console.log(
      `[Observability] Started. Prometheus metrics available on port ${METRICS_PORT}/metrics`,
    );

    const shutdown = async () => {
      if (sdk) {
        try {
          await sdk.shutdown();
          console.log("[Observability] SDK shut down successfully");
        } catch (error) {
          console.error("[Observability] Error shutting down SDK", error);
        }
      }
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("[Observability] Failed to start:", error);
  }
}
