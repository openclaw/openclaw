import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { normalizeTranscriptJsonValue } from "./transcript-json.js";

it("releases discarded tool-output backing strings while sharing persisted payloads", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      fileURLToPath(new URL("./transcript-json.retention.test-support.ts", import.meta.url)),
    ],
    process.env,
    undefined,
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), signal },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

it.each([
  ["numbers", () => ({ zero: -0, nan: Number.NaN, infinity: Number.POSITIVE_INFINITY })],
  ["omitted members", () => ({ absent: undefined, symbol: Symbol("hidden"), fn: () => {} })],
  [
    "sparse array",
    () => Object.assign([undefined, Number.NaN, Symbol("hidden"), () => {}], { length: 6 }),
  ],
  ["symbol property", () => ({ visible: 1, [Symbol("hidden")]: 2 })],
  ["nonenumerable", () => Object.defineProperty({ visible: 1 }, "hidden", { value: 2 })],
  ["accessor", () => Object.defineProperty({}, "value", { enumerable: true, get: () => 7 })],
  ["date", () => new Date(0)],
  ["wrappers", () => [Object(7), Object("text"), Object(false), Object(Symbol("hidden"))]],
  ["toJSON key", () => ({ toJSON: (key: string) => ({ key }) })],
  ["nested toJSON key", () => ({ nested: { toJSON: (key: string) => key } })],
  ["proxy", () => new Proxy({ value: 7 }, {})],
] as const)("matches native JSON bytes for %s", (_name, createValue) => {
  const value = createValue();
  const expected = JSON.stringify({ data: value });
  expect(JSON.stringify({ data: normalizeTranscriptJsonValue(value, "data") })).toBe(expected);
});

it("normalizes native raw JSON to its represented value", () => {
  const value: unknown = runInNewContext('JSON.rawJSON("123")');
  expect(JSON.stringify(value)).toBe("123");
  expect(normalizeTranscriptJsonValue(value, "data")).toBe(123);
});

it("does not probe a proxy prototype with operations native JSON does not use", () => {
  const prototype = new Proxy(
    {},
    {
      has() {
        throw new Error("Unexpected inherited property probe");
      },
    },
  );
  const value: unknown = Object.create(prototype, { visible: { value: 7, enumerable: true } });
  expect(JSON.stringify(value)).toBe('{"visible":7}');
  expect(normalizeTranscriptJsonValue(value, "data")).toEqual({ visible: 7 });
});

it("omits an own __proto__ member whose toJSON returns undefined", () => {
  const value = { ["__proto__"]: { toJSON: () => undefined } };
  expect(JSON.stringify(value)).toBe("{}");
  const normalized = normalizeTranscriptJsonValue(value, "data");
  expect(normalized).toEqual({});
  expect(Object.getOwnPropertyDescriptor(normalized, "__proto__")).toBeUndefined();
  expect(JSON.stringify(normalized)).toBe("{}");
});

it("lets toJSON observe earlier siblings before their JSON normalization", () => {
  const value = {
    first: Number.NaN,
    later: { toJSON: () => ({ sawNaN: Number.isNaN(value.first) }) },
  };
  const expected = '{"data":{"first":null,"later":{"sawNaN":true}}}';
  expect(JSON.stringify({ data: value })).toBe(expected);
  expect(JSON.stringify({ data: normalizeTranscriptJsonValue(value, "data") })).toBe(expected);
});

it("retains ordinary shared JSON and unchanged frozen containers", () => {
  const values = [null, true, "text", 7];
  const shared = { values };
  const value = { first: shared, second: shared };
  expect(normalizeTranscriptJsonValue(value, "data")).toBe(value);
  expect(value.first).toBe(shared);
  expect(value.second).toBe(shared);
  expect(shared.values).toBe(values);
  const frozen = Object.freeze({ nested: Object.freeze({ value: 7 }) });
  expect(normalizeTranscriptJsonValue(frozen, "data")).toBe(frozen);
});

it.each(["frozen", "preserved"] as const)(
  "copies changed %s containers without changing the source",
  (mode) => {
    const source = { nested: { omitted: undefined, values: [undefined, -0] } };
    if (mode === "frozen") {
      Object.freeze(source.nested.values);
      Object.freeze(source.nested);
      Object.freeze(source);
    }
    const normalized = normalizeTranscriptJsonValue(source, "data", mode === "preserved");
    expect(normalized).toEqual({ nested: { values: [null, 0] } });
    expect(normalized).not.toBe(source);
    expect(source.nested).toHaveProperty("omitted", undefined);
    expect(source.nested.values).toEqual([undefined, -0]);
  },
);

it.each([
  ["bigint", () => ({ value: 1n })],
  [
    "circular reference",
    () => {
      const value: { self?: unknown } = {};
      value.self = value;
      return value;
    },
  ],
] as const)("rejects %s just as native JSON does", (_name, createValue) => {
  const value = createValue();
  expect(() => JSON.stringify({ data: value })).toThrow(TypeError);
  expect(() => normalizeTranscriptJsonValue(value, "data")).toThrow(TypeError);
});
