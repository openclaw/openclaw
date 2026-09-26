import { expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticUsageEvent,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { finalizePluginModelUsage } from "./runtime-model-usage.js";

it("publishes only reported native usage fields without treating unknown tokens as zero", () => {
  const events: DiagnosticUsageEvent[] = [];
  const stop = onTrustedInternalDiagnosticEvent(
    markTrustedOtelDiagnosticListener((event) => {
      if (event.type === "model.usage") {
        events.push(event);
      }
    }),
  );
  try {
    const usage = finalizePluginModelUsage({
      cfg: { diagnostics: { enabled: true } },
      hostPluginId: "fixture",
      estimate: "none",
      target: { provider: "fixture", model: "native" },
      rawUsage: { cost: 0.02 },
    });
    expect(usage).toEqual({ costUsd: 0.02 });
    expect(events).toHaveLength(1);
    expect(events[0]?.usage).toEqual({});
    expect(events[0]?.costUsd).toBe(0.02);
    finalizePluginModelUsage({
      cfg: { diagnostics: { enabled: true } },
      estimate: "none",
      target: { provider: "fixture", model: "native" },
      rawUsage: { input: 4 },
    });
    expect(events[1]?.usage).toEqual({ input: 4 });
    expect(events[1]).not.toHaveProperty("costUsd");
  } finally {
    stop();
  }
});
