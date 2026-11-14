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

const prototypeValue = (beta = 2) => ({ ["__proto__"]: { kind: "data" }, alpha: 1, beta });
const literals = [
  "Guard.CodePointCount",
  "Hashing.Hash",
  "Function('return 1')",
  "import('example')",
];
const sharedOptions = { shareSchemaFunctions: true, hoistSchemaFunctions: true };
const cases: Array<[name: string, schema: XSchema, accepted: unknown[], rejected: unknown[]]> = [
  ["decimal multiples", Type.Number({ multipleOf: 0.01 }), [0, 1.2, 0.29], [0.001, 1.234, "1.20"]],
  [
    "structural constants and own prototype-looking keys independent of property order",
    { const: prototypeValue() },
    [prototypeValue(), { beta: 2, alpha: 1, ["__proto__"]: { kind: "data" } }],
    [
      prototypeValue(3),
      { ...prototypeValue(), extra: true },
      { __proto__: { kind: "data" }, alpha: 1, beta: 2 },
    ],
  ],
  [
    "literal data containing compiler helper names",
    Type.Union([
      ...literals.map((literal) => Type.Literal(literal)),
      Type.String({ pattern: "^Guard\\.NotAHelper$" }),
    ]),
    [...literals, "Guard.NotAHelper"],
    ["CodePointCount", "Hash", "NotAHelper"],
  ],
  [
    "Unicode length and escaped regular-expression literals",
    Type.String({ pattern: String.raw`^(?:/|\n|\u2028|🐚)+$`, minLength: 1, maxLength: 4 }),
    ["/", "\n", "\u2028", "🐚🐚🐚🐚"],
    ["", "x", "🐚🐚🐚🐚🐚"],
  ],
  [
    "built-in format assertions",
    Type.String({ format: "uuid" }),
    ["337c6f6a-39aa-4c69-b969-e6c2d9d309c8"],
    ["not-a-uuid", 42],
  ],
  [
    "local reference targets",
    {
      type: "object",
      $defs: { word: { type: "string", minLength: 2 } },
      properties: { word: { $ref: "#/$defs/word" } },
      required: ["word"],
      additionalProperties: false,
    },
    [{ word: "ok" }],
    [{ word: "x" }, { word: 42 }, { word: "ok", extra: true }],
  ],
  [
    "structural array uniqueness",
    Type.Array(Type.Object({ value: Type.Number() }), { uniqueItems: true }),
    [[{ value: 1 }, { value: 2 }]],
    [[{ value: 1 }, { value: 1 }]],
  ],
  [
    "unevaluated properties without leaking evaluation state between inputs",
    {
      allOf: [{ type: "object", properties: { value: { type: "number" } } }],
      unevaluatedProperties: false,
    },
    [{ value: 1 }],
    [{ value: 1, extra: true }, { value: "wrong" }],
  ],
];

describe("standalone TypeBox checks", () => {
  it("emits the same shared module regardless of earlier compilations", async () => {
    const entries = [{ name: "check", schema: Type.Array(Type.Number(), { minItems: 1 }) }];
    const first = await compileStandaloneValidators(entries, sharedOptions);
    expect(await compileStandaloneValidators(entries, sharedOptions)).toBe(first);
    Build(Type.Object({}, { propertyNames: { type: "string" } }));
    expect(await compileStandaloneValidators(entries, sharedOptions)).toBe(first);
  });

  it("lets consumers tree-shake unused checks from a shared schema pool", async () => {
    const marker = "unused-predicate-must-not-load";
    const source = await compileStandaloneValidators(
      [
        { name: "keep", schema: Type.String() },
        { name: "discard", schema: Type.Literal(marker) },
      ],
      sharedOptions,
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
    "preserves %s with runtime code generation disabled",
    async (_name, schema, accepted, rejected) => {
      for (const options of [{}, { shareSchemaFunctions: true }, sharedOptions]) {
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
