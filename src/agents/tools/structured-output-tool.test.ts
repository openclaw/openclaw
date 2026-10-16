import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { validateStructuredOutputSchema } from "../subagents/swarm/swarm-output-schema.js";
import { isToolResultError } from "../tool-result-error.js";
import {
  consumeSwarmStructuredOutput,
  createStructuredOutputTool,
  peekSwarmStructuredOutput,
} from "./structured-output-tool.js";

const runId = "structured-output-tool-test";

describe("structured_output", () => {
  afterEach(() => {
    consumeSwarmStructuredOutput(runId);
  });

  it.each([
    { label: "object", result: { answer: "yes" } },
    { label: "encoded object", result: '{"answer":"yes"}' },
  ])("records a valid $label result", async ({ result: input }) => {
    const tool = createStructuredOutputTool({
      runId,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    const result = await tool.execute("call-1", { result: input });
    expect(isToolResultError(result)).toBe(false);
    expect(consumeSwarmStructuredOutput(runId)).toEqual({
      structured: { answer: "yes" },
      invalidAttempts: 0,
    });
  });

  it("preserves unsafe integer literals when decoding a result", async () => {
    const tool = createStructuredOutputTool({ runId, schema: { type: "object" } });
    await tool.execute("call-1", { result: '{"id":9007199254740993}' });
    expect(consumeSwarmStructuredOutput(runId)?.structured).toEqual({ id: "9007199254740993" });
  });

  it.each([{ type: "string" }, {}, { anyOf: [{ type: "string" }, { type: "object" }] }])(
    "preserves JSON-looking strings that satisfy schema %j",
    async (schema) => {
      const tool = createStructuredOutputTool({ runId, schema });
      const result = '{"answer":"yes"}';
      await tool.execute("call-1", { result });
      expect(consumeSwarmStructuredOutput(runId)?.structured).toBe(result);
    },
  );

  it.each([
    { count: "bad" },
    "not JSON",
    '{"count":"bad"}',
    '{"count":9007199254740993}',
    JSON.stringify('{"count":3}'),
  ])("nudges once then freezes schemaError for %j", async (result) => {
    const tool = createStructuredOutputTool({
      runId,
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });
    expect(Value.Check(tool.parameters, { result })).toBe(true);
    expect(tool.description).toContain('"count"');
    await expect(tool.execute("call-1", { result })).rejects.toThrow("Retry once");
    const rejectedRetry = await tool.execute("call-2", { result });
    const rejectedLaterCall = await tool.execute("call-3", { result: '{"count":3}' });
    expect(rejectedRetry.details).toMatchObject({ status: "rejected", success: false });
    expect(rejectedLaterCall.details).toMatchObject({ status: "rejected", success: false });
    expect(isToolResultError(rejectedRetry)).toBe(true);
    expect(isToolResultError(rejectedLaterCall)).toBe(true);
    expect(peekSwarmStructuredOutput(runId)).toMatchObject({
      structured: undefined,
      invalidAttempts: 2,
    });
    expect(peekSwarmStructuredOutput(runId)?.schemaError).toBeTruthy();
  });

  it.each([{ result: ["one", "two"] }, { result: '["one","two"]' }])(
    "accepts array result %j and rejects malformed schemas before spawn",
    async ({ result }) => {
      const arraySchema = { type: "array", items: { type: "string" } };
      expect(validateStructuredOutputSchema({})).toBeUndefined();
      expect(validateStructuredOutputSchema(arraySchema)).toBeUndefined();
      expect(validateStructuredOutputSchema({ type: "object", properties: "invalid" })).toContain(
        "Invalid sessions_spawn outputSchema",
      );
      const tool = createStructuredOutputTool({ runId, schema: arraySchema });
      await expect(tool.execute("call-array", { result })).resolves.toBeDefined();
      expect(peekSwarmStructuredOutput(runId)?.structured).toEqual(["one", "two"]);
    },
  );

  it("resumes the one-retry budget from durable state", async () => {
    let durableState: ReturnType<typeof peekSwarmStructuredOutput>;
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const first = createStructuredOutputTool({
      runId,
      schema,
      onStateChange: (state) => {
        durableState = state;
      },
    });
    await expect(first.execute("call-1", { result: { count: "bad" } })).rejects.toThrow(
      "Retry once",
    );

    consumeSwarmStructuredOutput(runId);
    const restored = createStructuredOutputTool({
      runId,
      schema,
      initialState: durableState,
    });
    const rejected = await restored.execute("call-2", { result: { count: "still bad" } });
    expect(rejected.details).toMatchObject({ status: "rejected", success: false });
    expect(isToolResultError(rejected)).toBe(true);
    expect(peekSwarmStructuredOutput(runId)?.invalidAttempts).toBe(2);
  });

  it("preserves the retry budget when asynchronously persisting an invalid retry fails", async () => {
    const persist = vi.fn();
    const tool = createStructuredOutputTool({
      runId,
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      onStateChange: persist,
    });
    await expect(tool.execute("initial", { result: { count: "bad" } })).rejects.toThrow(
      "Retry once",
    );
    const previous = peekSwarmStructuredOutput(runId);
    const entered = createDeferred();
    const release = createDeferred();
    persist.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise.then(() => {
        throw new Error("storage unavailable");
      });
    });
    const rejected = expect(
      tool.execute("failed-write", { result: { count: "still bad" } }),
    ).rejects.toThrow("Failed to persist structured_output: storage unavailable");
    await entered.promise;
    try {
      expect(peekSwarmStructuredOutput(runId)).toEqual(previous);
    } finally {
      release.resolve();
    }
    await rejected;
    expect(peekSwarmStructuredOutput(runId)).toEqual(previous);

    const corrected = { count: 2 };
    expect((await tool.execute("corrected", { result: corrected })).details).toEqual({
      status: "recorded",
    });
    expect(peekSwarmStructuredOutput(runId)).toEqual({
      structured: corrected,
      invalidAttempts: 0,
    });
    expect(persist).toHaveBeenLastCalledWith({ structured: corrected, invalidAttempts: 0 });
    await expect(tool.execute("duplicate", { result: { count: 3 } })).rejects.toThrow(
      "already recorded",
    );
    expect(consumeSwarmStructuredOutput(runId)?.structured).toEqual(corrected);
  });

  it("publishes one acknowledged result when tool calls overlap", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const persist = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const tool = createStructuredOutputTool({ runId, schema: {}, onStateChange: persist });
    const first = tool.execute("first", { result: { answer: "first" } });
    await entered.promise;
    const duplicate = expect(
      tool.execute("second", { result: { answer: "second" } }),
    ).rejects.toThrow("already recorded");
    try {
      expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
    expect((await first).details).toEqual({ status: "recorded" });
    await duplicate;
    expect(peekSwarmStructuredOutput(runId)?.structured).toEqual({ answer: "first" });
    expect(persist).toHaveBeenCalledOnce();
  });
});
