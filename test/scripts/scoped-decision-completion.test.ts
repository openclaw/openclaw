import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCase } from "../../scripts/scoped-decision/decision.ts";
import { fixtures } from "../../scripts/scoped-decision/fixtures.ts";
import { createSimpleCompletionRoute } from "../../scripts/scoped-decision/simple-completion.ts";
import type { ClassifierInput } from "../../scripts/scoped-decision/types.ts";

type Sdk = typeof import("openclaw/plugin-sdk/simple-completion-runtime");
type Prepared = Awaited<ReturnType<Sdk["prepareSimpleCompletionModelForAgent"]>>;
type Assistant = Awaited<ReturnType<Sdk["completeWithPreparedSimpleCompletionModel"]>>;
const sdk = vi.hoisted(() => ({
  prepare: vi.fn<Sdk["prepareSimpleCompletionModelForAgent"]>(),
  complete: vi.fn<Sdk["completeWithPreparedSimpleCompletionModel"]>(),
  extract: vi.fn<Sdk["extractAssistantText"]>(),
}));
vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: sdk.prepare,
  completeWithPreparedSimpleCompletionModel: sdk.complete,
  extractAssistantText: sdk.extract,
}));

const activity: ClassifierInput["activities"][number] = {
  id: "campaign-x",
  label: "campaign X",
  currentDirection: "A",
};
const input: ClassifierInput = {
  message: "Use B for campaign X.",
  activities: [activity],
};
const candidate = '{"kind":"directive","activityId":"campaign-x","direction":"B"}';
const expectedSelection = { provider: "openai", modelId: "gpt-4.1-mini" };

function prepared(): Extract<Prepared, { model: unknown }> {
  return {
    model: {
      provider: "openai",
      id: "gpt-4.1-mini",
      name: "gpt-4.1-mini",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    auth: { source: "synthetic-test", mode: "api-key" },
    selection: { ...expectedSelection, agentDir: "/tmp/scoped-decision-fixture" },
  };
}
function assistant(): Assistant {
  return {
    role: "assistant",
    content: [{ type: "text", text: candidate }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 40,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 52,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function route(overrides: Partial<Parameters<typeof createSimpleCompletionRoute>[0]> = {}) {
  return createSimpleCompletionRoute({
    cfg: {},
    agentId: "fixture-agent",
    useUtilityModel: true,
    expectedSelection,
    authorizeInput: () => true,
    assertCurrent: () => {},
    ...overrides,
  });
}
beforeEach(() => {
  sdk.prepare.mockReset().mockResolvedValue(prepared());
  sdk.complete.mockReset().mockImplementation(async (params) => {
    params.assertCurrent?.();
    return assistant();
  });
  sdk.extract.mockReset().mockReturnValue(candidate);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scoped decision completion adapter", { concurrent: false }, () => {
  it.each<{ name: string; value: unknown }>([
    { name: "non-object input", value: null },
    { name: "non-string message", value: { ...input, message: 7 } },
    { name: "oversized message", value: { ...input, message: "x".repeat(4097) } },
    { name: "missing activities", value: { message: input.message } },
    { name: "non-array activities", value: { ...input, activities: {} } },
    {
      name: "too many activities",
      value: {
        ...input,
        activities: Array.from({ length: 9 }, (_, index) => ({
          ...activity,
          id: `activity-${index}`,
        })),
      },
    },
    { name: "invalid activity shape", value: { ...input, activities: [null] } },
    {
      name: "invalid activity ID",
      value: { ...input, activities: [{ ...activity, id: "bad/id" }] },
    },
    { name: "non-string activity ID", value: { ...input, activities: [{ ...activity, id: 7 }] } },
    { name: "duplicate activity IDs", value: { ...input, activities: [activity, activity] } },
    { name: "invalid label type", value: { ...input, activities: [{ ...activity, label: null }] } },
    { name: "empty label", value: { ...input, activities: [{ ...activity, label: "" }] } },
    {
      name: "oversized label",
      value: { ...input, activities: [{ ...activity, label: "x".repeat(65) }] },
    },
    {
      name: "invalid current direction",
      value: { ...input, activities: [{ ...activity, currentDirection: "C" }] },
    },
  ])(
    "rejects $name at the direct adapter boundary before authorization or credential preparation",
    async ({ value }) => {
      const authorizeInput = vi.fn<(value: ClassifierInput) => boolean>().mockReturnValue(true);
      const classifier = route({ authorizeInput }).classify;
      const result = await Reflect.apply(classifier, undefined, [value]);

      expect(result).toMatchObject({
        error: "invalid-classifier-input",
        modelCalls: 0,
        physicalProviderRequests: 0,
      });
      expect(authorizeInput).not.toHaveBeenCalled();
      expect(sdk.prepare).not.toHaveBeenCalled();
      expect(sdk.complete).not.toHaveBeenCalled();
    },
  );

  it("denies input before credential preparation or completion", async () => {
    expect(await route({ authorizeInput: () => false }).classify(input)).toMatchObject({
      error: "processing-denied",
      modelCalls: 0,
      physicalProviderRequests: 0,
    });
    expect(sdk.prepare).not.toHaveBeenCalled();
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("strips unrelated input and activity fields before permission checks and the SDK prompt", async () => {
    const authorizeInput = vi.fn<(value: ClassifierInput) => boolean>().mockReturnValue(true);
    const source = {
      ...input,
      privateHistory: "PRIVATE_HISTORY_CANARY",
      activities: [
        { ...activity, destinationId: "PRIVATE_DESTINATION_CANARY", sharingPolicy: "public" },
      ],
    };
    const result = await route({ authorizeInput }).classify(source);

    expect(result.text).toBe(candidate);
    expect(authorizeInput).toHaveBeenCalled();
    for (const [authorized] of authorizeInput.mock.calls) {
      expect(authorized).toEqual(input);
    }
    expect(sdk.complete).toHaveBeenCalledOnce();
    expect(sdk.complete.mock.calls[0]?.[0].context.messages).toEqual([
      { role: "user", content: JSON.stringify(input), timestamp: expect.any(Number) },
    ]);
    expect(source.privateHistory).toBe("PRIVATE_HISTORY_CANARY");
  });

  it("retains the authorized input snapshot when the caller mutates it during preparation", async () => {
    const source = structuredClone(input);
    const authorizeInput = vi.fn<(value: ClassifierInput) => boolean>().mockReturnValue(true);
    sdk.prepare.mockImplementationOnce(async () => {
      await Promise.resolve();
      source.message = "PRIVATE_CHANGED_MESSAGE_CANARY";
      source.activities = [{ id: "campaign-y", label: "campaign Y", currentDirection: "B" }];
      return prepared();
    });

    const result = await route({ authorizeInput }).classify(source);

    expect(result.text).toBe(candidate);
    expect(authorizeInput).toHaveBeenCalled();
    for (const [authorized] of authorizeInput.mock.calls) {
      expect(authorized).toEqual(input);
    }
    expect(sdk.complete.mock.calls[0]?.[0].context.messages).toEqual([
      { role: "user", content: JSON.stringify(input), timestamp: expect.any(Number) },
    ]);
  });

  it("requests the approved utility with bounded context and no tools", async () => {
    const result = await route().classify(input);
    expect(sdk.prepare).toHaveBeenCalledWith({
      cfg: {},
      agentId: "fixture-agent",
      useUtilityModel: true,
    });
    expect(sdk.complete).toHaveBeenCalledOnce();
    const call = sdk.complete.mock.calls[0];
    if (call === undefined) {
      throw new Error("Expected one completion request.");
    }
    const [request] = call;
    expect(request.context.tools).toEqual([]);
    expect(request.context.messages).toEqual([
      { role: "user", content: JSON.stringify(input), timestamp: expect.any(Number) },
    ]);
    expect(request.options).toMatchObject({ maxTokens: 384, temperature: 0 });
    expect(request.options?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      text: candidate,
      modelCalls: 1,
      physicalProviderRequests: null,
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    });
  });

  it("rejects a different utility selection without dispatch", async () => {
    const fallback = prepared();
    fallback.selection.modelId = "gpt-4.1";
    sdk.prepare.mockResolvedValueOnce(fallback);
    expect(await route().classify(input)).toMatchObject({
      error: "selection-not-approved",
      modelCalls: 0,
    });
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("rechecks processing permission after awaited preparation", async () => {
    let permitted = true;
    sdk.prepare.mockImplementationOnce(async () => {
      permitted = false;
      return prepared();
    });
    expect(await route({ authorizeInput: () => permitted }).classify(input)).toMatchObject({
      error: "completion-unavailable",
      modelCalls: 0,
    });
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("does not dispatch when the preparation-spanning deadline expires before preparation returns", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    sdk.prepare.mockImplementationOnce(async () => {
      await Promise.resolve();
      deadline.abort();
      return prepared();
    });

    const result = await route({ deadlineMs: 25 }).classify(input);

    expect(timeout).toHaveBeenCalledWith(25);
    expect(result).toMatchObject({ error: "completion-unavailable", modelCalls: 0 });
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("discards a result arriving after the deadline but preserves observed usage", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    sdk.complete.mockImplementationOnce(async (params) => {
      params.assertCurrent?.();
      await Promise.resolve();
      deadline.abort();
      return assistant();
    });

    const result = await route({ deadlineMs: 25 }).classify(input);

    expect(result).toMatchObject({
      error: "completion-unavailable",
      modelCalls: 1,
      physicalProviderRequests: null,
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    });
    expect(result.text).toBeUndefined();
    expect(sdk.extract).not.toHaveBeenCalled();
  });

  it("passes live authority into the SDK's post-transport dispatch boundary", async () => {
    let current = true;
    let dispatched = false;
    sdk.complete.mockImplementationOnce(async (params) => {
      await Promise.resolve();
      current = false;
      params.assertCurrent?.();
      dispatched = true;
      return assistant();
    });
    const result = await route({
      assertCurrent: () => {
        if (!current) {
          throw new Error("revoked");
        }
      },
    }).classify(input);
    expect(dispatched).toBe(false);
    expect(result).toMatchObject({
      error: "completion-unavailable",
      modelCalls: 1,
      physicalProviderRequests: null,
    });
    expect(result.text).toBeUndefined();
  });

  it.each(["missing", "all-zero"])("keeps %s token usage unknown", async (variant) => {
    const response = assistant();
    if (variant === "missing") {
      Reflect.deleteProperty(response, "usage");
    } else {
      response.usage.input = 0;
      response.usage.output = 0;
      response.usage.totalTokens = 0;
    }
    sdk.complete.mockResolvedValueOnce(response);
    const result = await route().classify(input);
    expect(result.text).toBe(candidate);
    expect(result.usage).toBeUndefined();
  });

  it("keeps observed usage but discards output when authority expires in flight", async () => {
    let permitted = true;
    sdk.complete.mockImplementationOnce(async () => {
      permitted = false;
      return assistant();
    });
    const result = await route({ authorizeInput: () => permitted }).classify(input);
    expect(result).toMatchObject({ error: "completion-unavailable", usage: { totalTokens: 52 } });
    expect(result.text).toBeUndefined();
    expect(sdk.extract).not.toHaveBeenCalled();
  });

  it("sanitizes provider errors without claiming free inference", async () => {
    sdk.complete.mockRejectedValueOnce(new Error("PRIVATE_ERROR_CANARY"));
    const result = await route().classify(input);
    expect(result).toMatchObject({
      error: "completion-unavailable",
      modelCalls: 1,
      physicalProviderRequests: null,
    });
    expect(result.usage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR_CANARY");
  });
});

describe("scoped decision completion composition", { concurrent: false }, () => {
  it.each([
    {
      name: "authorized instruction",
      text: candidate,
      outcome: "authorization-preview",
      reason: "explicit-authorized-directive",
      preview: {
        activityId: "campaign-x",
        destinationId: "company",
        policyId: "release-x",
        payload: { kind: "direction-update", activityId: "campaign-x", direction: "B" },
        text: "Use B for campaign-x.",
      },
    },
    {
      name: "wrong but otherwise permitted target",
      text: '{"kind":"directive","activityId":"campaign-y","direction":"B"}',
      outcome: "blocked",
      reason: "candidate-does-not-match-instruction",
      preview: null,
    },
    {
      name: "malformed completion output",
      text: "not JSON",
      outcome: "blocked",
      reason: "candidate-malformed",
      preview: null,
    },
  ])(
    "composes projection, completion, gating, and usage for $name",
    async ({ text, outcome, reason, preview }) => {
      const fixture = fixtures[0];
      if (!fixture) {
        throw new Error("Expected the clear-authorized fixture.");
      }
      const authorizeInput = vi.fn<(value: ClassifierInput) => boolean>().mockReturnValue(true);
      sdk.extract.mockReturnValueOnce(text);
      const result = await runCase({
        id: fixture.id,
        message: fixture.message,
        host: () => fixture.host,
        route: route({ authorizeInput }),
      });

      const projected = {
        message: "Use B for campaign X.",
        activities: [
          { id: "campaign-x", label: "campaign X", currentDirection: "A" },
          { id: "campaign-y", label: "campaign Y", currentDirection: "A" },
        ],
      };
      expect(authorizeInput).toHaveBeenCalledWith(projected);
      expect(sdk.complete).toHaveBeenCalledOnce();
      expect(sdk.complete.mock.calls[0]?.[0].context.messages).toEqual([
        { role: "user", content: JSON.stringify(projected), timestamp: expect.any(Number) },
      ]);
      expect(result.gate).toEqual({ outcome, reason });
      expect(result.preview).toEqual(preview);
      expect(result).not.toHaveProperty("simulatedDelivery");
      expect(result.metrics).toMatchObject({
        classifierInvocations: 1,
        modelCalls: 1,
        physicalProviderRequests: null,
        usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
        inlineModelOverhead: null,
      });
    },
  );
});
