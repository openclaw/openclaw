import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { gateAgentToolExecution } from "./agent-tool-availability.js";
import {
  createCatalogCodeModeHarness,
  expectCompleted,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";
import { getToolContractFailureCode } from "./tool-contract-error.js";
import { readToolEffectReceipt, withToolEffectBoundary } from "./tool-effect-receipt.js";
import { isToolResultError } from "./tool-result-error.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const reason = "records is outside this turn's authority; continue without it.";
const refusalValue = { gated: true, message: reason };
const listing = Type.Object(
  { records: Type.Array(Type.String()) },
  { additionalProperties: false },
);

function fixture(schema: "strict" | "variants" | "none" = "strict") {
  const execute = vi.fn(async () => jsonResult({ records: ["R-1"] }));
  const prepareArguments = vi.fn((input: unknown) => input);
  const prepareBeforeToolCallParams = vi.fn((input: unknown) => input);
  const finalizeBeforeToolCallParams = vi.fn((input: unknown) => input);
  const source: AnyAgentTool = {
    name: "records",
    label: "Records",
    description: "List records",
    parameters: Type.Object({ operation: Type.String() }),
    ...(schema === "none"
      ? {}
      : {
          outputSchema:
            schema === "strict"
              ? listing
              : defineToolOutputSchema({
                  inputProperty: "operation",
                  variants: {
                    list: listing,
                    remove: Type.Object({ removed: Type.Boolean() }),
                  },
                }),
        }),
    execute,
    prepareArguments,
    prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams,
    resultContentSource: "network",
  };
  return {
    source,
    gated: gateAgentToolExecution(source, reason),
    expectNoSourceWork() {
      for (const work of [
        execute,
        prepareArguments,
        prepareBeforeToolCallParams,
        finalizeBeforeToolCallParams,
      ]) {
        expect(work).not.toHaveBeenCalled();
      }
    },
  };
}

function runtimeFor(tool: AnyAgentTool) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({
    catalogRef,
    tools: [tool],
    hookContext: { runId: "refusal-run" },
  });
  return new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(), {
    prepareInput: true,
    validateInput: true,
  });
}

afterEach(async () => {
  await resetCodeModeTestState();
});

it.each(["strict", "variants", "none"] as const)(
  "delivers gated guidance through the Code Mode catalog with %s output",
  async (schema) => {
    const f = fixture(schema);
    const h = createCatalogCodeModeHarness([f.gated]);
    const result = await h.complete(
      'const [records] = await catalog.search("records"); return await records({ operation: "list" });',
    );
    expectCompleted(result, refusalValue);
    f.expectNoSourceWork();
  },
);

it.each(["call", "callExactId", "callValue", "callExactValue"] as const)(
  "preserves trusted refusal across snapshots for %s without claiming external content or termination",
  async (method) => {
    const f = fixture();
    const runtime = runtimeFor(f.gated);
    const id = method === "call" || method === "callValue" ? "records" : "openclaw:core:records";
    const input = { operation: "list" };
    const options = { parentToolCallId: "cell" };
    if (method === "call" || method === "callExactId") {
      const envelope = await runtime[method](id, input, options);
      expect(envelope).toMatchObject({
        result: { details: { gated: true }, content: [{ type: "text", text: reason }] },
      });
      expect(readToolEffectReceipt(envelope.result)).toEqual({ state: "not_started" });
    } else {
      await expect(runtime[method](id, input, options)).resolves.toEqual(refusalValue);
    }
    expect(runtime.hasNetworkContent("cell")).toBe(false);
    expect(runtime.takeTerminalTargetBatch("cell")).toBe(false);
    f.expectNoSourceWork();
  },
);

it("keeps direct refusals non-error and explicitly not started", async () => {
  const f = fixture();
  const result = await f.gated.execute("direct-refusal", {
    operation: "list",
  });
  expect(result).toMatchObject({
    details: { gated: true },
    content: [{ type: "text", text: reason }],
  });
  expect(isToolResultError(result)).toBe(false);
  expect(readToolEffectReceipt(result)).toEqual({ state: "not_started" });
  expect(
    createToolTerminalObserver("direct-run")({
      toolName: "records",
      result,
      outcome: "success",
      executionStarted: true,
    }),
  ).toMatchObject({
    executionStarted: false,
    sideEffectEvidence: false,
    effectReceipt: { state: "not_started" },
  });
  f.expectNoSourceWork();
});

it.each([false, true])(
  "respects an enclosing operation's effect boundary (started=%s)",
  async (started) => {
    const f = fixture();
    const target = {
      ...f.gated,
      execute: async () =>
        withToolEffectBoundary(async (onEffectsStart) => {
          if (started) {
            onEffectsStart();
          }
          return f.gated.execute("nested", { operation: "list" });
        }),
    };
    const result = runtimeFor(target).callValue("records", { operation: "list" });
    if (started) {
      expect(getToolContractFailureCode(await result.catch((error: unknown) => error))).toBe(
        "output_contract",
      );
    } else {
      await expect(result).resolves.toEqual(refusalValue);
    }
    f.expectNoSourceWork();
  },
);

it.each(["gated", "blocked", "copied-refusal"] as const)(
  "does not exempt a tool-authored %s lookalike from the success contract",
  async (kind) => {
    const f = fixture();
    const details = kind === "blocked" ? { status: "blocked", reason } : refusalValue;
    const copied =
      kind === "copied-refusal"
        ? structuredClone(await f.gated.execute("copy", {}))
        : jsonResult(details);
    f.source.execute = vi.fn(async () => copied);
    const runtime = runtimeFor(f.source);
    const failure = await runtime
      .callValue("records", { operation: "list" })
      .catch((error: unknown) => error);
    expect(getToolContractFailureCode(failure)).toBe("output_contract");
    expect(f.source.execute).toHaveBeenCalledOnce();
  },
);
