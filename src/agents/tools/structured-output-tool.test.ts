import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { validateStructuredOutputSchema } from "../subagents/swarm/swarm-output-schema.js";
import { isToolResultError } from "../tool-result-error.js";
import {
  consumeSwarmStructuredOutput as consume,
  createStructuredOutputTool,
  peekSwarmStructuredOutput as peek,
} from "./structured-output-tool.js";

const runId = "structured-output-tool-test";
const fieldSchema = (key: string, type: string) => ({
  type: "object",
  properties: { [key]: { type } },
  required: [key],
});
type ToolOptions = Parameters<typeof createStructuredOutputTool>[0];
const countSchema = fieldSchema("count", "number");
function makeTool(options: Partial<ToolOptions> = {}) {
  const tool = createStructuredOutputTool({ runId, schema: countSchema, ...options });
  return { tool, submit: (result: unknown) => tool.execute("call", { result }) };
}
function expectRejected(result: Awaited<ReturnType<ReturnType<typeof makeTool>["submit"]>>) {
  expect(result.details).toMatchObject({ status: "rejected", success: false });
  expect(isToolResultError(result)).toBe(true);
}

describe("structured_output", () => {
  afterEach(() => void consume(runId));

  it.each([{ answer: "yes" }, '{"answer":"yes"}'])("records a valid result %j", async (input) => {
    const { submit } = makeTool({
      schema: { ...fieldSchema("answer", "string"), additionalProperties: false },
    });
    const result = await submit(input);
    expect(isToolResultError(result)).toBe(false);
    expect(consume(runId)).toEqual({ structured: { answer: "yes" }, invalidAttempts: 0 });
  });

  it("preserves unsafe integer literals when decoding a result", async () => {
    const { submit } = makeTool({ schema: { type: "object" } });
    await submit('{"id":9007199254740993}');
    expect(consume(runId)?.structured).toEqual({ id: "9007199254740993" });
  });

  it.each([{ type: "string" }, {}, { anyOf: [{ type: "string" }, { type: "object" }] }])(
    "preserves JSON-looking strings that satisfy schema %j",
    async (schema) => {
      const { submit } = makeTool({ schema });
      const result = '{"answer":"yes"}';
      await submit(result);
      expect(consume(runId)?.structured).toBe(result);
    },
  );

  it.each([
    { count: "bad" },
    "not JSON",
    '{"count":"bad"}',
    '{"count":9007199254740993}',
    JSON.stringify('{"count":3}'),
  ])("nudges once then freezes schemaError for %j", async (result) => {
    const { tool, submit } = makeTool();
    expect(Value.Check(tool.parameters, { result })).toBe(true);
    expect(tool.description).toContain('"count"');
    await expect(submit(result)).rejects.toThrow("Retry once");
    const retry = await submit(result);
    expectRejected(retry);
    expect(retry.details).toMatchObject({ schemaError: expect.any(String) });
    const frozen = peek(runId);
    expect(frozen).toMatchObject({ structured: undefined, invalidAttempts: 2 });
    expect(frozen?.schemaError).toBeTruthy();
    // A valid payload after the budget is spent is reported as unevaluated, not
    // as failing the previous attempt's validation.
    const exhausted = await submit('{"count":3}');
    expectRejected(exhausted);
    expect(exhausted.details).toMatchObject({
      reason: "retry_budget_exhausted",
      error: expect.stringContaining("not evaluated"),
    });
    expect(exhausted.details).not.toHaveProperty("schemaError");
    expect(peek(runId)).toEqual(frozen);
  });

  it.each([{ result: ["one", "two"] }, { result: '["one","two"]' }])(
    "accepts arrays (%j)",
    async ({ result }) => {
      const arraySchema = { type: "array", items: { type: "string" } };
      expect(validateStructuredOutputSchema(arraySchema)).toBeUndefined();
      const { submit } = makeTool({ schema: arraySchema });
      await expect(submit(result)).resolves.toBeDefined();
      expect(peek(runId)?.structured).toEqual(["one", "two"]);
    },
  );

  it("resumes the one-retry budget from durable state", async () => {
    const persist = vi.fn<NonNullable<ToolOptions["onStateChange"]>>();
    const first = makeTool({ onStateChange: persist });
    await expect(first.submit({ count: "bad" })).rejects.toThrow("Retry once");
    consume(runId);
    const restored = makeTool({ initialState: persist.mock.calls[0]?.[0] });
    expectRejected(await restored.submit({ count: "still bad" }));
    expect(peek(runId)?.invalidAttempts).toBe(2);
  });

  it("preserves the retry budget when asynchronously persisting an invalid retry fails", async () => {
    const persist = vi.fn();
    const { submit } = makeTool({ onStateChange: persist });
    await expect(submit({ count: "bad" })).rejects.toThrow("Retry once");
    const previous = peek(runId);
    const gate = createEnteredGate();
    persist.mockImplementationOnce(async () => {
      await gate.wait();
      throw new Error("storage unavailable");
    });
    const rejected = expect(submit({ count: "still bad" })).rejects.toThrow(
      "Failed to persist structured_output: storage unavailable",
    );
    await gate.entered;
    try {
      expect(peek(runId)).toEqual(previous);
    } finally {
      gate.release();
    }
    await rejected;
    expect(peek(runId)).toEqual(previous);

    const corrected = { count: 2 };
    expect((await submit(corrected)).details).toEqual({ status: "recorded" });
    expect(peek(runId)).toEqual({ structured: corrected, invalidAttempts: 0 });
    expect(persist).toHaveBeenLastCalledWith({ structured: corrected, invalidAttempts: 0 });
    await expect(submit({ count: 3 })).rejects.toThrow("already recorded");
    expect(consume(runId)?.structured).toEqual(corrected);
  });

  it("publishes one acknowledged result when tool calls overlap", async () => {
    const gate = createEnteredGate();
    const persist = vi.fn(gate.wait);
    const { submit } = makeTool({ schema: {}, onStateChange: persist });
    const first = submit({ answer: "first" });
    await gate.entered;
    const duplicate = expect(submit({ answer: "second" })).rejects.toThrow("already recorded");
    try {
      expect(peek(runId)).toBeUndefined();
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      gate.release();
    }
    expect((await first).details).toEqual({ status: "recorded" });
    await duplicate;
    expect(peek(runId)?.structured).toEqual({ answer: "first" });
    expect(persist).toHaveBeenCalledOnce();
  });
});
