import { describe, expect, it } from "vitest";
import { formatTelemetryExporterSummary } from "./telemetry-exporter-summary.js";

function event(seq: number, fields: Record<string, unknown>) {
  return {
    seq,
    type: "telemetry.exporter",
    source: "diagnostics-otel",
    target: "logs",
    transport: "otlp-http-protobuf",
    outcome: "failure",
    ...fields,
  };
}

function expectSummary(
  events: readonly unknown[],
  status: "ok" | "warn",
  lines: readonly string[],
) {
  const summary = formatTelemetryExporterSummary({ events });
  expect(summary).toEqual({ title: "Telemetry exporters", status, lines });
}

describe("formatTelemetryExporterSummary", () => {
  it("renders bounded redacted exporter facts without misattribution", () => {
    expectSummary(
      [
        event(1, { source: "https://spoofed.example" }),
        event(2, {
          target: "traces",
          outcome: "recovered",
          reason: "export_failed",
          mode: "default_endpoint",
          url: "https://collector.example/private",
          headers: { authorization: "secret" },
          error: "raw collector failure",
        }),
        event(3, {
          source: "diagnostics-prometheus",
          target: "metrics",
          transport: "prometheus-scrape",
          reason: "handler_failed",
        }),
        event(4, {
          source: "custom_exporter",
          target: "metrics",
          transport: "external-sdk",
          outcome: "started",
          reason: "configured",
        }),
        event(5, { transport: "stdout", outcome: "started" }),
        event(6, { reason: "shutdown_failed", mode: "configured" }),
        event(7, { source: "custom_exporter", transport: "vendor-proto", outcome: "started" }),
        event(8, {
          source: "second_exporter",
          target: "metrics",
          transport: "collector.internal:4318",
          reason: "queue_full",
        }),
      ],
      "warn",
      [
        "custom_exporter · metrics · started · external SDK ownership",
        "custom_exporter · logs · started · vendor-proto",
        "diagnostics-otel · traces · recovered · OTLP/HTTP protobuf (dependency default endpoint) · after export failure",
        "diagnostics-otel · logs · failed · OTLP/HTTP protobuf (explicit endpoint) · shutdown failed",
        "diagnostics-otel · logs · started · stdout",
        "diagnostics-prometheus · metrics · failed · prometheus-scrape · handler failed",
        "second_exporter · metrics · failed · exporter · queue full",
      ],
    );
  });

  it("renders stdout recovery without exposing failure details", () => {
    expectSummary(
      [
        event(1, {
          transport: "stdout",
          outcome: "recovered",
          reason: "emit_failed",
          error: "private stdout details",
        }),
      ],
      "ok",
      ["diagnostics-otel · logs · recovered · stdout · after emit failure"],
    );
  });
});
