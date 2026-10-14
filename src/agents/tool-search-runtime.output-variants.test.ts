import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import {
  defineToolOutputSchema,
  readToolOutputSchemaVariants,
  selectToolOutputSchema,
} from "./schema/tool-output-schema.js";
import { getToolContractFailureCode } from "./tool-contract-error.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(async () => {
  resetGlobalHookRunner();
  await resetCodeModeTestState();
});

function rewriteOperation(operation = "remove") {
  const hook = vi.fn(async () => ({ params: { operation } }));
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
  );
  return hook;
}

async function expectContractFailure(result: Promise<unknown>, code = "output_contract") {
  expect(getToolContractFailureCode(await result.catch((error: unknown) => error))).toBe(code);
}

function createFixture(
  options: {
    validateInput?: boolean;
    output?: unknown;
    executeTool?: ToolSearchToolContext["executeTool"];
    outputSchema?: AnyAgentTool["outputSchema"];
    prepareBeforeToolCallParams?: AnyAgentTool["prepareBeforeToolCallParams"];
    finalizeBeforeToolCallParams?: AnyAgentTool["finalizeBeforeToolCallParams"];
  } = {},
) {
  const execute = vi.fn(async (_toolCallId: string, _input: unknown) =>
    jsonResult(options.output ?? { removed: true }),
  );
  const target: AnyAgentTool = {
    name: "records",
    label: "Records",
    description: "List or remove records",
    parameters: Type.Object({ operation: Type.String() }),
    outputSchema:
      options.outputSchema ??
      defineToolOutputSchema({
        inputProperty: "operation",
        variants: {
          list: Type.Object({ records: Type.Array(Type.String()) }),
          remove: Type.Object({ removed: Type.Boolean() }),
        },
      }),
    prepareBeforeToolCallParams: options.prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams: options.finalizeBeforeToolCallParams,
    execute,
  };
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });
  const runtime = new ToolSearchRuntime(
    { catalogRef, executeTool: options.executeTool },
    resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
    { validateInput: options.validateInput ?? false },
  );
  return { target, execute, runtime };
}

describe("Tool Search input-dependent output contracts", () => {
  it.each([
    { validateInput: true, operation: "legacy", output: { removed: true }, accepted: true },
    { validateInput: false, operation: "list", output: { records: ["R-1"] }, accepted: false },
  ])(
    "preserves both caller and executed contracts (validateInput=$validateInput, operation=$operation, output=$output)",
    async ({ validateInput, operation, output, accepted }) => {
      const hook = rewriteOperation();
      const { runtime, execute } = createFixture({ validateInput, output });

      const result = await runtime.callValue("records", { operation }).catch((e: unknown) => e);

      if (accepted) {
        expect(result).toEqual(output);
      } else {
        expect(getToolContractFailureCode(result)).toBe("output_contract");
      }
      expect(hook).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
    },
  );

  it("accepts hook rewrites between operations with compatible result contracts", async () => {
    rewriteOperation();
    const removal = Type.Object({ removed: Type.Boolean() });
    const { runtime, execute } = createFixture({
      outputSchema: defineToolOutputSchema({
        inputProperty: "operation",
        variants: { remove: removal, delete: removal },
      }),
    });

    await expect(runtime.callValue("records", { operation: "delete" })).resolves.toEqual({
      removed: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
  });

  it("rejects an incompatible hook result before Code Mode can consume it", async () => {
    rewriteOperation();
    const { target, execute } = createFixture();
    const continued = vi.fn(async () => jsonResult({ consumed: true }));
    const continuation: AnyAgentTool = {
      name: "consume_records",
      label: "Consume records",
      description: "Record that the caller received its list result",
      parameters: Type.Object({}),
      execute: continued,
    };
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, target, continuation] });

    const result = resultDetails(
      await expectDefined(h.tools[0], "Code Mode exec").execute("rewritten-list", {
        code: `
          try {
            const list = await records({operation: "list"});
            await consume_records({});
            return list.records.length;
          } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && "effectStatus" in error) {
              return { code: error.code, effectStatus: error.effectStatus };
            }
            throw error;
          }
        `,
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      value: { code: "output_contract", effectStatus: "unknown" },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
    expect(continued).not.toHaveBeenCalled();
  });

  it("selects the finalized operation after tool-owned preparation and hook changes", async () => {
    rewriteOperation("list");
    const { runtime, execute } = createFixture({
      output: { records: [] },
      prepareBeforeToolCallParams: () => ({ operation: "list" }),
      finalizeBeforeToolCallParams: () => ({ operation: "remove" }),
    });
    await expectContractFailure(runtime.callValue("records", { operation: "list" }));
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
  });

  it.each([
    { label: "unsupported annotation version", version: 2, mapping: { list: 0 } },
    { label: "missing branch", version: 1, mapping: { list: 2 } },
  ])("rejects $label before any side effect", async ({ version, mapping }) => {
    const { runtime, execute } = createFixture({
      outputSchema: Type.Union([Type.String(), Type.Boolean()], {
        "x-openclaw-input-discriminator": { version, inputProperty: "operation", mapping },
      }),
    });
    await expectContractFailure(
      runtime.callValue("records", { operation: "list" }),
      "invalid_contract",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("compiles even unselected output branches before any side effect", async () => {
    const { runtime, execute } = createFixture({
      outputSchema: {
        anyOf: [{ type: "boolean" }, { type: "sting" }],
        "x-openclaw-input-discriminator": {
          version: 1,
          inputProperty: "operation",
          mapping: { list: 0, remove: 1 },
        },
      } as never,
    });
    await expectContractFailure(
      runtime.callValue("records", { operation: "list" }),
      "invalid_contract",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { references: false, output: { owner: "current", records: ["R-1"] }, accepted: true },
    { references: false, output: { owner: "current", removed: true }, accepted: false },
    { references: true, output: { owner: "current", removed: true }, accepted: true },
    { references: false, output: { records: ["R-1"] }, accepted: false },
    { references: true, output: { records: ["R-1"] }, accepted: false },
  ])(
    "preserves root constraints and uses umbrella fallback only for references ($references, $output)",
    async ({ references, output, accepted }) => {
      const definitions = {
        listing: Type.Object({ records: Type.Array(Type.String()) }),
        removal: Type.Object({ removed: Type.Boolean() }),
      };
      const { runtime, execute } = createFixture({
        output,
        outputSchema: {
          type: "object",
          properties: { owner: { const: "current" } },
          required: ["owner"],
          ...(references ? { $defs: definitions } : {}),
          anyOf: references
            ? [{ $ref: "#/$defs/listing" }, { $ref: "#/$defs/removal" }]
            : [definitions.listing, definitions.removal],
          "x-openclaw-input-discriminator": {
            version: 1,
            inputProperty: "operation",
            mapping: { list: 0, remove: 1 },
          },
        } as never,
      });

      const result = await runtime
        .callValue("records", { operation: "list" })
        .catch((e: unknown) => e);

      if (accepted) {
        expect(result).toEqual(output);
      } else {
        expect(getToolContractFailureCode(result)).toBe("output_contract");
      }
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("preserves recursive root alternatives through nested children", async () => {
    const output = { child: { child: null } };
    const { runtime, execute } = createFixture({
      output,
      outputSchema: {
        anyOf: [
          { type: "null" },
          { type: "object", properties: { child: { $ref: "#" } }, required: ["child"] },
        ],
        "x-openclaw-input-discriminator": {
          version: 1,
          inputProperty: "operation",
          mapping: { empty: 0, node: 1 },
        },
      } as never,
    });

    await expect(runtime.callValue("records", { operation: "node" })).resolves.toEqual(output);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["$dynamicRef", "$recursiveRef"])(
    "retains the exact umbrella schema when a schema position contains %s",
    (reference) => {
      const schema = defineToolOutputSchema({
        inputProperty: "operation",
        variants: {
          list: Type.Object({ records: Type.Array(Type.String()) }),
          remove: Type.Object({ child: { [reference]: "#" } as never }),
        },
      });

      expect(readToolOutputSchemaVariants(schema)?.canNarrow).toBe(false);
      expect(selectToolOutputSchema(schema, { operation: "list" })).toBe(schema);
    },
  );

  it("does not treat property names or annotation data as schema references", () => {
    const schema = defineToolOutputSchema({
      inputProperty: "operation",
      variants: {
        list: Type.Object(
          { $ref: Type.String() },
          { default: { $ref: "#" }, examples: [{ $dynamicRef: "#" }] },
        ),
        remove: Type.Object({ removed: Type.Boolean() }),
      },
    });

    expect(readToolOutputSchemaVariants(schema)?.canNarrow).toBe(true);
    expect(selectToolOutputSchema(schema, { operation: "list" })).not.toBe(schema);
  });

  it.each(["deep", "wide", "cyclic"])(
    "keeps the original schema when reference inspection cannot safely finish a %s graph",
    (shape) => {
      const schema: Record<string, unknown> = {
        ...defineToolOutputSchema({
          inputProperty: "operation",
          variants: { list: Type.String(), remove: Type.Boolean() },
        }),
      };
      if (shape === "cyclic") {
        schema.not = schema;
      } else if (shape === "wide") {
        schema.properties = Object.fromEntries(
          Array.from({ length: 5_000 }, (_, index) => [String(index), Type.String()]),
        );
      } else {
        let child: Record<string, unknown> = schema;
        for (let index = 0; index < 500; index += 1) {
          const next = {};
          child.not = next;
          child = next;
        }
      }

      expect(readToolOutputSchemaVariants(schema)?.canNarrow).toBe(false);
      expect(selectToolOutputSchema(schema, { operation: "list" })).toBe(schema);
    },
  );

  it("revalidates projected results against the operation that executed", async () => {
    const { runtime, execute } = createFixture({
      executeTool: async (params) => {
        const result = await params.tool.execute(
          params.toolCallId,
          params.input,
          params.signal,
          params.onUpdate,
          undefined as never,
        );
        await params.acceptResultBeforeProjection(result);
        return jsonResult({ records: ["R-1"] });
      },
    });

    await expectContractFailure(runtime.callValue("records", { operation: "remove" }));
    expect(execute).toHaveBeenCalledOnce();
  });
});
