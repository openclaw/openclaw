import vm from "node:vm";
import { build, transform } from "esbuild";
import { Type } from "typebox";
import { Build, type XSchema } from "typebox/schema";
import { describe, expect, it } from "vitest";
import {
  compileStandaloneValidators,
  emitStandaloneValidatorSource,
  type StandaloneValidatorOptions,
} from "../scripts/lib/typebox-standalone.mts";

async function standaloneCheck(schema: XSchema, options?: StandaloneValidatorOptions) {
  const source = await compileStandaloneValidators([{ name: "check", schema }], options);
  const compiled = await transform(source, { format: "cjs", loader: "js" });
  const sandbox = { module: { exports: {} }, TextEncoder, TextDecoder };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  expect(() => vm.runInContext('Function("return 1")()', context)).toThrow(
    "Code generation from strings disallowed",
  );
  new vm.Script(compiled.code).runInContext(context);
  const check: unknown = Reflect.get(sandbox.module.exports, "check");
  if (typeof check !== "function") {
    throw new Error("Standalone validator did not export its check");
  }
  return (value: unknown): boolean => check(value) === true;
}

const cases: Array<{
  name: string;
  schema: XSchema;
  accepted: unknown[];
  rejected: unknown[];
}> = [
  {
    name: "decimal multiples",
    schema: Type.Number({ multipleOf: 0.01 }),
    accepted: [0, 1.2, 0.29],
    rejected: [0.001, 1.234, "1.20"],
  },
  {
    name: "structural constants and own prototype-looking keys independent of property order",
    schema: { const: { ["__proto__"]: { kind: "data" }, alpha: 1, beta: 2 } },
    accepted: [
      { ["__proto__"]: { kind: "data" }, alpha: 1, beta: 2 },
      { beta: 2, alpha: 1, ["__proto__"]: { kind: "data" } },
    ],
    rejected: [
      { ["__proto__"]: { kind: "data" }, alpha: 1, beta: 3 },
      { ["__proto__"]: { kind: "data" }, alpha: 1, beta: 2, extra: true },
      { __proto__: { kind: "data" }, alpha: 1, beta: 2 },
    ],
  },
  {
    name: "literal data containing compiler helper names",
    schema: Type.Union([
      Type.Literal("Guard.CodePointCount"),
      Type.Literal("Hashing.Hash"),
      Type.Literal("Function('return 1')"),
      Type.Literal("import('example')"),
      Type.String({ pattern: "^Guard\\.NotAHelper$" }),
    ]),
    accepted: [
      "Guard.CodePointCount",
      "Hashing.Hash",
      "Guard.NotAHelper",
      "Function('return 1')",
      "import('example')",
    ],
    rejected: ["CodePointCount", "Hash", "NotAHelper"],
  },
  {
    name: "Unicode length and escaped regular-expression literals",
    schema: Type.String({ pattern: String.raw`^(?:/|\n|\u2028|🐚)+$`, minLength: 1, maxLength: 4 }),
    accepted: ["/", "\n", "\u2028", "🐚🐚🐚🐚"],
    rejected: ["", "x", "🐚🐚🐚🐚🐚"],
  },
  {
    name: "built-in format assertions",
    schema: Type.String({ format: "uuid" }),
    accepted: ["337c6f6a-39aa-4c69-b969-e6c2d9d309c8"],
    rejected: ["not-a-uuid", 42],
  },
  {
    name: "local reference targets",
    schema: {
      type: "object",
      $defs: { word: { type: "string", minLength: 2 } },
      properties: { word: { $ref: "#/$defs/word" } },
      required: ["word"],
      additionalProperties: false,
    },
    accepted: [{ word: "ok" }],
    rejected: [{ word: "x" }, { word: 42 }, { word: "ok", extra: true }],
  },
  {
    name: "structural array uniqueness",
    schema: Type.Array(Type.Object({ value: Type.Number() }), { uniqueItems: true }),
    accepted: [[{ value: 1 }, { value: 2 }]],
    rejected: [[{ value: 1 }, { value: 1 }]],
  },
  {
    name: "unevaluated properties without leaking evaluation state between inputs",
    schema: {
      allOf: [{ type: "object", properties: { value: { type: "number" } } }],
      unevaluatedProperties: false,
    },
    accepted: [{ value: 1 }],
    rejected: [{ value: 1, extra: true }, { value: "wrong" }],
  },
];

describe("standalone TypeBox checks", () => {
  it("emits the same shared module regardless of earlier compilations", async () => {
    const entries = [{ name: "check", schema: Type.Array(Type.Number(), { minItems: 1 }) }];
    const options = { shareSchemaFunctions: true, hoistSchemaFunctions: true };
    const first = await compileStandaloneValidators(entries, options);
    expect(await compileStandaloneValidators(entries, options)).toBe(first);
    Build(Type.Object({}, { propertyNames: { type: "string" } }));
    expect(await compileStandaloneValidators(entries, options)).toBe(first);
  });

  it("lets consumers tree-shake unused checks from a shared schema pool", async () => {
    const marker = "unused-predicate-must-not-load";
    const source = await compileStandaloneValidators(
      [
        { name: "keep", schema: Type.String() },
        { name: "discard", schema: Type.Literal(marker) },
      ],
      { shareSchemaFunctions: true, hoistSchemaFunctions: true },
    );
    expect(source).toContain(marker);
    const bundled = await build({
      stdin: { contents: 'export { keep } from "validators";', loader: "js" },
      bundle: true,
      format: "esm",
      write: false,
      plugins: [
        {
          name: "generated-validators",
          setup(builder) {
            builder.onResolve({ filter: /^validators$/ }, () => ({
              path: "validators",
              namespace: "generated",
            }));
            builder.onLoad({ filter: /.*/, namespace: "generated" }, () => ({
              contents: source,
              loader: "js",
            }));
          },
        },
      ],
    });
    expect(bundled.outputFiles[0]?.text).not.toContain(marker);
  });

  it.each(cases)(
    "preserves $name with runtime code generation disabled",
    async ({ schema, accepted, rejected }) => {
      for (const options of [
        {},
        { shareSchemaFunctions: true },
        { shareSchemaFunctions: true, hoistSchemaFunctions: true },
      ]) {
        const check = await standaloneCheck(schema, options);
        for (const value of accepted) {
          expect(check(value)).toBe(true);
        }
        for (const value of rejected) {
          expect(check(value)).toBe(false);
        }
      }
    },
  );

  it("requires a static owner for refinement captures instead of dropping their constraint", async () => {
    const schema = Type.Refine(Type.Integer(), (value) => value >= 0);
    await expect(compileStandaloneValidators([{ name: "check", schema }])).rejects.toThrow(
      "unsupported standalone external value",
    );
    await expect(
      compileStandaloneValidators([{ name: "check", schema }], {
        externals: new Map([
          [schema["~refine"][0], "{ check: new Function('value', 'return value >= 0') }"],
        ]),
      }),
    ).rejects.toThrow("codegen-free");
    const check = await standaloneCheck(schema, {
      shareSchemaFunctions: true,
      externals: new Map([[schema["~refine"][0], "{ check: value => value >= 0 }"]]),
    });
    expect(check(0)).toBe(true);
    expect(check(-1)).toBe(false);
    expect(check(0.5)).toBe(false);
  });

  it("rejects cyclic captures instead of emitting a different data constraint", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => emitStandaloneValidatorSource("check", "", [cycle], "value => true")).toThrow(
      "unsupported standalone external value",
    );
  });
});
