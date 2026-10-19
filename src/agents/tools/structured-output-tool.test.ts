import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
    expectRejected(await submit(result));
    expectRejected(await submit('{"count":3}'));
    expect(peek(runId)).toMatchObject({ structured: undefined, invalidAttempts: 2 });
    expect(peek(runId)?.schemaError).toBeTruthy();
  });

  it.each([{ result: ["one", "two"] }, { result: '["one","two"]' }])(
    "accepts arrays (%j), rejects malformed schemas before spawn",
    async ({ result }) => {
      const arraySchema = { type: "array", items: { type: "string" } };
      expect(validateStructuredOutputSchema({})).toBeUndefined();
      expect(validateStructuredOutputSchema(arraySchema)).toBeUndefined();
      expect(validateStructuredOutputSchema({ type: "object", properties: "invalid" })).toContain(
        "Invalid sessions_spawn outputSchema",
      );
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
    const entered = createDeferred();
    const release = createDeferred();
    persist.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise.then(() => {
        throw new Error("storage unavailable");
      });
    });
    const rejected = expect(submit({ count: "still bad" })).rejects.toThrow(
      "Failed to persist structured_output: storage unavailable",
    );
    await entered.promise;
    try {
      expect(peek(runId)).toEqual(previous);
    } finally {
      release.resolve();
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
    const entered = createDeferred();
    const release = createDeferred();
    const persist = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const { submit } = makeTool({ schema: {}, onStateChange: persist });
    const first = submit({ answer: "first" });
    await entered.promise;
    const duplicate = expect(submit({ answer: "second" })).rejects.toThrow("already recorded");
    try {
      expect(peek(runId)).toBeUndefined();
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
    expect((await first).details).toEqual({ status: "recorded" });
    await duplicate;
    expect(peek(runId)?.structured).toEqual({ answer: "first" });
    expect(persist).toHaveBeenCalledOnce();
  });
});
