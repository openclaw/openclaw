import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { createRuntimeLlm, type RuntimeLlmAuthority } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  complete: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquire,
  completeWithPreparedSimpleCompletionModel: hoisted.complete,
  resolveSimpleCompletionSelectionForAgent: hoisted.select,
}));

const cfg = { agents: { defaults: { model: "openai/gpt-5.5" } } } satisfies OpenClawConfig;

const preparedModel = {
  async [Symbol.asyncDispose]() {},
  selection: { provider: "openai", modelId: "gpt-5.5", agentDir: "/tmp/openclaw-agent" },
  model: makeProviderModelFixture({
    provider: "openai",
    id: "gpt-5.5",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  }),
  auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
} satisfies Extract<Awaited<ReturnType<typeof hoisted.acquire>>, { model: unknown }>;

function runtime(
  config: OpenClawConfig = cfg,
  authority: RuntimeLlmAuthority = { allowComplete: true, pluginIdForPolicy: "trusted-plugin" },
) {
  return createRuntimeLlm({ getConfig: () => config, authority });
}

function complete(config: OpenClawConfig = cfg) {
  return runtime(config).complete({ messages: [{ role: "user", content: "Ping" }] });
}

function completion(usage: unknown) {
  return { content: [{ type: "text", text: "done" }], usage, stopReason: "stop" };
}

function trustedEvent(event: object) {
  return {
    trusted: true,
    hostPluginId: "trusted-plugin",
    internal: true,
    event: expect.objectContaining(event),
  };
}

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0, total: 0 };

function captureUsageEvents() {
  const events: Array<{
    event: Extract<DiagnosticEventPayload, { type: "model.usage" }>;
    hostPluginId?: string;
    internal?: boolean;
    trusted: boolean;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent(
    markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
      if (event.type === "model.usage") {
        events.push({
          event,
          hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    }),
  );
  return { events, stop };
}

describe("runtime.llm.complete diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.acquire.mockResolvedValue(preparedModel);
    hoisted.select.mockReturnValue(preparedModel.selection);
    hoisted.complete.mockResolvedValue(
      completion({
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      }),
    );
  });

  it("emits one trusted usage event using only host-owned plugin identity", async () => {
    const usageEvents = captureUsageEvents();
    const llm = runtime(cfg, {
      caller: { kind: "host", id: "runtime-test" },
      pluginIdForPolicy: "trusted-plugin",
      allowComplete: true,
    });

    const result = await llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      purpose: "test-purpose",
      caller: { kind: "plugin", id: "spoofed-plugin" },
      pluginId: "spoofed-plugin",
      telemetry: { pluginId: "nested-spoofed-plugin" },
    } as Parameters<typeof llm.complete>[0] & {
      caller: unknown;
      pluginId: string;
      telemetry: { pluginId: string };
    });
    usageEvents.stop();

    expect(result).toEqual(
      expect.objectContaining({
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } },
        audit: { caller: { kind: "host", id: "runtime-test" }, purpose: "test-purpose" },
      }),
    );
    expect(usageEvents.events).toEqual([
      trustedEvent({
        type: "model.usage",
        agentId: "main",
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, promptTokens: 18, total: 25 },
        costUsd: 0.0042,
      }),
    ]);
  });

  it.each([
    ["unpriced adapter zero", { total: 0 }, undefined],
    ["authored free price", { total: 0 }, 0, true],
    ["provider-billed zero", { total: 0, totalOrigin: "provider-billed" }, 0],
    ["zero with recorded components", { total: 0, input: 0.25 }, 0],
    ["legacy numeric zero", 0, 0],
    ["legacy USD zero", { totalUsd: 0, total: 1 }, 0],
  ] as const)(
    "preserves cost evidence without inventing prices: %s",
    async (_name, cost, expected, free) => {
      const prepared = {
        ...preparedModel,
        selection: { ...preparedModel.selection, provider: "pricing-fixture", modelId: "unpriced" },
        model: { ...preparedModel.model, provider: "pricing-fixture", id: "unpriced" },
      };
      hoisted.acquire.mockResolvedValue(prepared);
      hoisted.select.mockReturnValue(prepared.selection);
      hoisted.complete.mockResolvedValue(completion({ input: 1_000, output: 500, cost }));
      const config: OpenClawConfig = free
        ? {
            ...cfg,
            models: {
              providers: {
                "pricing-fixture": {
                  baseUrl: "https://pricing.invalid",
                  models: [
                    {
                      ...prepared.model,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
          }
        : cfg;
      const result = await runtime(config, {
        allowComplete: true,
        allowModelOverride: true,
      }).complete({
        model: "pricing-fixture/unpriced",
        messages: [{ role: "user", content: "Ping" }],
      });
      expect(result.usage?.costUsd).toBe(expected);
    },
  );

  it.each([
    ["absent", undefined],
    ["all-zero", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }],
    ["reasoning-only", { reasoningTokens: 7 }],
    ["unavailable context usage", { contextUsage: { state: "unavailable" } }],
    ["input-only", { input: 4 }, { ...emptyUsage, input: 4, promptTokens: 4, total: 4 }],
    ["cache-only", { cacheRead: 9 }, { ...emptyUsage, cacheRead: 9, promptTokens: 9, total: 9 }],
    ["positive explicit cost-only", { cost: { total: 0.0042 } }, emptyUsage, 0.0042],
    ["zero explicit cost-only", { cost: { total: 0 } }],
    ["disabled", { input: 1 }, undefined, undefined, true],
  ] as const)(
    "emits usage only for positive enabled tokens or cost: %s",
    async (_name, rawUsage, expectedEventUsage, expectedCostUsd, disabled) => {
      hoisted.complete.mockResolvedValueOnce(completion(rawUsage));
      const usageEvents = captureUsageEvents();
      await complete(disabled ? { ...cfg, diagnostics: { enabled: false } } : cfg);
      usageEvents.stop();

      if (expectedEventUsage) {
        expect(usageEvents.events).toEqual([
          trustedEvent({
            usage: expectedEventUsage,
            ...(expectedCostUsd !== undefined ? { costUsd: expectedCostUsd } : {}),
          }),
        ]);
      } else {
        expect(usageEvents.events).toHaveLength(0);
      }
    },
  );

  it.each([
    ["resolved provider error", "error", [{ type: "text", text: "partial" }], "partial"],
    ["thinking-only completion", "stop", [{ type: "thinking", thinking: "hidden" }], ""],
  ] as const)("keeps %s usage silent", async (_name, stopReason, content, expectedText) => {
    hoisted.complete.mockResolvedValueOnce({
      content,
      stopReason,
      usage: { input: 11, output: 7, totalTokens: 18 },
    });
    const usageEvents = captureUsageEvents();
    await expect(complete()).resolves.toMatchObject({ text: expectedText });
    usageEvents.stop();

    expect(usageEvents.events).toEqual([]);
  });

  it("emits no usage when the provider fails", async () => {
    const usageEvents = captureUsageEvents();
    hoisted.complete.mockRejectedValueOnce(new Error("provider failed"));
    await expect(complete()).rejects.toThrow("provider failed");
    usageEvents.stop();

    expect(usageEvents.events).toHaveLength(0);
  });
});
