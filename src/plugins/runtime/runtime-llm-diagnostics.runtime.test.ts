import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

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
    contextWindow: 128_000,
    maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  }),
  auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
} satisfies Extract<Awaited<ReturnType<typeof hoisted.acquire>>, { model: unknown }>;

function runtime(config: OpenClawConfig = cfg) {
  return createRuntimeLlm({
    getConfig: () => config,
    authority: { allowComplete: true, pluginIdForPolicy: "trusted-plugin" },
  });
}

function complete(config: OpenClawConfig = cfg) {
  return runtime(config).complete({ messages: [{ role: "user", content: "Ping" }] });
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

function usageCase(
  name: string,
  rawUsage: unknown,
  expectedUsage?: typeof emptyUsage,
  expectedCost?: number,
  enabled = true,
) {
  return [name, rawUsage, enabled, expectedUsage, expectedCost] as const;
}

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
    hoisted.acquire.mockReset();
    hoisted.complete.mockReset();
    hoisted.select.mockReset();
    hoisted.acquire.mockResolvedValue(preparedModel);
    hoisted.select.mockReturnValue(preparedModel.selection);
    hoisted.complete.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      },
      stopReason: "stop",
    });
  });

  it("emits one trusted usage event using only host-owned plugin identity", async () => {
    const usageEvents = captureUsageEvents();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        pluginIdForPolicy: "trusted-plugin",
        allowComplete: true,
      },
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

    expect(result.execution).toEqual({
      mode: "direct-provider",
      owner: { kind: "provider", id: "openai" },
    });
    expect(result.audit).toEqual({
      caller: { kind: "host", id: "runtime-test" },
      purpose: "test-purpose",
    });
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
    { name: "unpriced adapter zero", cost: { total: 0 }, expected: undefined },
    { name: "authored free price", cost: { total: 0 }, free: true, expected: 0 },
    {
      name: "provider-billed zero",
      cost: { total: 0, totalOrigin: "provider-billed" },
      expected: 0,
    },
    { name: "zero with recorded components", cost: { total: 0, input: 0.25 }, expected: 0 },
    { name: "legacy numeric zero", cost: 0, expected: 0 },
    { name: "legacy USD zero", cost: { totalUsd: 0, total: 1 }, expected: 0 },
  ])(
    "preserves cost evidence without inventing prices: $name",
    async ({ cost, free, expected }) => {
      const prepared = {
        ...preparedModel,
        selection: { ...preparedModel.selection, provider: "pricing-fixture", modelId: "unpriced" },
        model: { ...preparedModel.model, provider: "pricing-fixture", id: "unpriced" },
      };
      hoisted.acquire.mockResolvedValue(prepared);
      hoisted.select.mockReturnValue(prepared.selection);
      hoisted.complete.mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 1_000, output: 500, cost },
      });
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
      const result = await createRuntimeLlm({
        getConfig: () => config,
        authority: { allowComplete: true, allowModelOverride: true },
      }).complete({
        model: "pricing-fixture/unpriced",
        messages: [{ role: "user", content: "Ping" }],
      });
      expect(result.usage?.costUsd).toBe(expected);
    },
  );

  it.each([
    usageCase("absent", undefined),
    usageCase("all-zero", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
    usageCase("reasoning-only", { reasoningTokens: 7 }),
    usageCase("unavailable context usage", { contextUsage: { state: "unavailable" } }),
    usageCase("input-only", { input: 4 }, { ...emptyUsage, input: 4, promptTokens: 4, total: 4 }),
    usageCase(
      "cache-only",
      { cacheRead: 9 },
      { ...emptyUsage, cacheRead: 9, promptTokens: 9, total: 9 },
    ),
    usageCase("positive explicit cost-only", { cost: { total: 0.0042 } }, emptyUsage, 0.0042),
    usageCase("zero explicit cost-only", { cost: { total: 0 } }),
    usageCase("disabled", { input: 1 }, undefined, undefined, false),
  ] as const)(
    "emits usage only for positive enabled tokens or cost: %s",
    async (_name, rawUsage, enabled, expectedEventUsage, expectedCostUsd) => {
      hoisted.complete.mockResolvedValueOnce({
        content: [{ type: "text", text: "done" }],
        usage: rawUsage,
        stopReason: "stop",
      });
      const usageEvents = captureUsageEvents();
      await complete(enabled ? cfg : { ...cfg, diagnostics: { enabled: false } });
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
