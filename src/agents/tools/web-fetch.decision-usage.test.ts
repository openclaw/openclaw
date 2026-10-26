import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registered } from "../../decisions/runtime.test-support.js";
import type { DecisionProviderV1 } from "../../decisions/types.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { assessWebFetchQuality } from "./web-fetch-decision-quality.js";

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

it.each(["accepted", "mode-replaced", "consent-revoked"] as const)(
  "records accepted model usage only when the fetch retains its Decision result (%s)",
  async (scenario) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          decisionModel: "fixture/fixture-v1",
          experimental: { decisionAssistance: true },
        },
      },
      tools: { web: { fetch: { decisionQuality: "apply" } } },
    };
    setRuntimeConfigSnapshot(config);
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => {
      if (scenario === "mode-replaced") {
        config.tools!.web!.fetch!.decisionQuality = "shadow";
      } else if (scenario === "consent-revoked") {
        config.agents!.defaults!.experimental!.decisionAssistance = false;
      }
      return {
        status: "ok",
        result: {
          model: "fixture-v1",
          answers: { unusable_page: { type: "boolean", probabilityTrue: 0.99 } },
          usage: { inputTokens: 4, outputTokens: 2 },
        },
      };
    });
    registered(evaluate);
    const events: DiagnosticEventPayload[] = [];
    onTestFinished(
      onTrustedInternalDiagnosticEvent(
        markTrustedOtelDiagnosticListener((event) => {
          if (event.type === "model.usage") {
            events.push(event);
          }
        }),
      ),
    );
    const payload = { text: "Access denied. Sign in to continue.", length: 34 };
    const result = await assessWebFetchQuality({
      config,
      agentId: "main",
      maxChars: 500,
      payload,
    });
    expect(evaluate).toHaveBeenCalledOnce();
    if (scenario === "accepted") {
      expect(result.quality).toMatchObject({ suppressed: true });
      expect(events).toEqual([
        expect.objectContaining({
          type: "model.usage",
          provider: "fixture",
          model: "fixture-v1",
          agentId: "main",
          usage: { input: 4, output: 2 },
        }),
      ]);
    } else {
      expect(result).toBe(payload);
      expect(events).toEqual([]);
    }
  },
);
