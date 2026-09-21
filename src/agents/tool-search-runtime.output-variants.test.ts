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

afterEach(() => {
  resetGlobalHookRunner();
  resetCodeModeTestState();
});

function createFixture(
  options: {
    validateInput?: boolean;
    output?: unknown;
    executeTool?: ToolSearchToolContext["executeTool"];
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
    outputSchema: defineToolOutputSchema({
      inputProperty: "operation",
      variants: {
        list: Type.Object({ records: Type.Array(Type.String()) }),
        remove: Type.Object({ removed: Type.Boolean() }),
      },
    }),
    execute,
  };
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });
  const runtime = new ToolSearchRuntime(
    { catalogRef, executeTool: options.executeTool },
    resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
    { validateInput: options.validateInput ?? false },
  );
  return { target, execute, runtime, catalogRef };
}

describe("Tool Search input-dependent output contracts", () => {
  it.each([true, false])(
    "rejects another operation's output after exactly one execution (validateInput=%s)",
    async (validateInput) => {
      const { runtime, execute } = createFixture({ validateInput });

      const error = await runtime
        .callValue("records", { operation: "list" })
        .catch((e: unknown) => e);

      expect(getToolContractFailureCode(error)).toBe("output_contract");
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { validateInput: true, operation: "legacy", output: { removed: true }, accepted: true },
    { validateInput: false, operation: "legacy", output: { removed: true }, accepted: true },
    { validateInput: true, operation: "list", output: { removed: true }, accepted: false },
    { validateInput: false, operation: "list", output: { removed: true }, accepted: false },
    { validateInput: true, operation: "list", output: { records: ["R-1"] }, accepted: false },
    { validateInput: false, operation: "list", output: { records: ["R-1"] }, accepted: false },
  ])(
    "preserves both caller and executed contracts (validateInput=$validateInput, operation=$operation, output=$output)",
    async ({ validateInput, operation, output, accepted }) => {
      const hook = vi.fn(async () => ({ params: { operation: "remove" } }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
      );
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ params: { operation: "remove" } }),
        },
      ]),
    );
    const { target, catalogRef, runtime, execute } = createFixture();
    const removal = Type.Object({ removed: Type.Boolean() });
    target.outputSchema = defineToolOutputSchema({
      inputProperty: "operation",
      variants: { remove: removal, delete: removal },
    });
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

    await expect(runtime.callValue("records", { operation: "delete" })).resolves.toEqual({
      removed: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
  });

  it("rejects an incompatible hook result before Code Mode can consume it", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ params: { operation: "remove" } }),
        },
      ]),
    );
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: async () => ({ params: { operation: "list" } }) },
      ]),
    );
    const { target, catalogRef, runtime, execute } = createFixture({ output: { records: [] } });
    target.prepareBeforeToolCallParams = () => ({ operation: "list" });
    target.finalizeBeforeToolCallParams = () => ({ operation: "remove" });
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

    const error = await runtime
      .callValue("records", { operation: "list" })
      .catch((e: unknown) => e);

    expect(getToolContractFailureCode(error)).toBe("output_contract");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: "remove" });
  });

  it.each([
    { label: "unsupported annotation version", version: 2, mapping: { list: 0 } },
    { label: "missing branch", version: 1, mapping: { list: 2 } },
  ])("rejects $label before any side effect", async ({ version, mapping }) => {
    const { target, catalogRef, runtime, execute } = createFixture();
    target.outputSchema = Type.Union([Type.String(), Type.Boolean()], {
      "x-openclaw-input-discriminator": { version, inputProperty: "operation", mapping },
    });
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

    const error = await runtime
      .callValue("records", { operation: "list" })
      .catch((e: unknown) => e);

    expect(getToolContractFailureCode(error)).toBe("invalid_contract");
    expect(execute).not.toHaveBeenCalled();
  });

  it("compiles even unselected output branches before any side effect", async () => {
    const { target, catalogRef, runtime, execute } = createFixture();
    target.outputSchema = {
      anyOf: [{ type: "boolean" }, { type: "sting" }],
      "x-openclaw-input-discriminator": {
        version: 1,
        inputProperty: "operation",
        mapping: { list: 0, remove: 1 },
      },
    } as never;
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

    const error = await runtime
      .callValue("records", { operation: "list" })
      .catch((e: unknown) => e);

    expect(getToolContractFailureCode(error)).toBe("invalid_contract");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(
    [false, true].flatMap((references) => [
      { references, output: { owner: "current", records: ["R-1"] }, accepted: true },
      { references, output: { owner: "current", removed: true }, accepted: references },
      { references, output: { records: ["R-1"] }, accepted: false },
    ]),
  )(
    "preserves root constraints and uses umbrella fallback only for references ($references, $output)",
    async ({ references, output, accepted }) => {
      const { target, catalogRef, runtime, execute } = createFixture({ output });
      const definitions = {
        listing: Type.Object({ records: Type.Array(Type.String()) }),
        removal: Type.Object({ removed: Type.Boolean() }),
      };
      target.outputSchema = {
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
      } as never;
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

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

  it.each([{ child: null }, { child: { child: null } }])(
    "preserves recursive root alternatives when returning $child",
    async (output) => {
      const { target, catalogRef, runtime, execute } = createFixture({ output });
      target.outputSchema = {
        anyOf: [
          { type: "null" },
          { type: "object", properties: { child: { $ref: "#" } }, required: ["child"] },
        ],
        "x-openclaw-input-discriminator": {
          version: 1,
          inputProperty: "operation",
          mapping: { empty: 0, node: 1 },
        },
      } as never;
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

      await expect(runtime.callValue("records", { operation: "node" })).resolves.toEqual(output);
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it.each(["$ref", "$dynamicRef", "$recursiveRef"])(
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

    const error = await runtime
      .callValue("records", { operation: "remove" })
      .catch((e: unknown) => e);

    expect(getToolContractFailureCode(error)).toBe("output_contract");
    expect(execute).toHaveBeenCalledOnce();
  });
});
