import { expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks as parse,
  stripPlainTextToolCallBlocks as strip,
} from "./tool-payload.js";

const parameter = (name: string, value: string) => `<parameter=${name}>${value}</parameter>`;
const call = (body = "", name = "write") => `<function=${name}>${body}</function>`;
const text = (value: string) => ({ type: "text", text: value });
const parseTool = (raw: string, name = "write", maxPayloadBytes?: number) =>
  parse(raw, { allowedToolNames: [name], maxPayloadBytes });
const content = [{ type: "image" }];
const result = { details: undefined, status: "ok" };

it.each([
  ["undefined", undefined, undefined],
  ["null", null, undefined],
  ["explicit details", { details: { ok: true }, content: [text("ignored")] }, { ok: true }],
  ["JSON text", { content: [...content, text('{"ok":true,"count":2}')] }, { ok: true, count: 2 }],
  ["raw text", { content: [text("not json")] }, "not json"],
] as const)("extracts %s payloads", (_name, input, expected) => {
  expect(extractToolPayload(input)).toEqual(expected);
});
it("preserves fallback payload identity", () => {
  expect(extractToolPayload({ content })).toBe(content);
  expect(extractToolPayload(result)).toBe(result);
});

const xmlArgument = parameter("value", "x");
const xmlLimit = new TextEncoder().encode(xmlArgument).byteLength + 3;
const jsonArgument = JSON.stringify({ content: "é".repeat(20) });
it.each([
  ["bracket with XML close", "[write]\n</function>", "write", undefined],
  ["XML whitespace bytes", call("\u00a0".repeat(129)), "write", 256],
  ["XML tail bytes", call(xmlArgument + "\u00a0\u00a0"), "write", xmlLimit],
  ["JSON UTF-8 bytes", "[write]\n" + jsonArgument + "\n[/write]", "write", 48],
  ["unoffered Harmony tool", 'commentary to=write code {"x":1}', "read", undefined],
] as const)("rejects %s", (_name, raw, allowed, maxPayloadBytes) => {
  expect(parseTool(raw, allowed, maxPayloadBytes)).toBeNull();
});
it("accepts an empty XML body at a zero-byte cap", () => {
  expect(parseTool(call(), "write", 0)?.[0]?.arguments).toEqual({});
});
it("preserves __proto__ as an own XML argument without changing the prototype", () => {
  const args = parse(call(parameter("__proto__", "value")))?.[0]?.arguments;
  expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(args ?? {}, "__proto__")?.value).toBe("value");
});
it("materializes one-shot tool-name iterables once per parse", () => {
  function* allowedNames() {
    yield "exec";
  }
  expect(
    parse("[tool:exec]<parameter=command>pwd</parameter>", { allowedToolNames: allowedNames() }),
  ).toMatchObject([{ name: "exec", arguments: { command: "pwd" } }]);
  expect(
    parse(call("", "exec") + call("", "exec"), { allowedToolNames: allowedNames() }),
  ).toHaveLength(2);
});
it("finds XML close tags without lowercased string offsets", () => {
  expect(parse(call("\n" + parameter("content", "\n\u0130\n") + "\n"))?.[0]?.arguments).toEqual({
    content: "\u0130",
  });
});

const oversizedXml = call(
  ["first", "second"]
    .map((name) => "\n" + parameter(name, "\n" + "x".repeat(140_000) + "\n"))
    .join("") + "\n",
);
it.each([
  ["adjacent XML", call("", "read") + call("", "read"), "after"],
  ["adjacent JSON", call("", "read") + '[tool:read] {"path":"/tmp"}', "after"],
  ["oversized JSON", "[tool:read] " + JSON.stringify({ value: "é".repeat(128_001) }), "after"],
  ["ambiguous close prefix", "[tool:exec]\n<parameter=command>\npwd\n</parameter>", "</func"],
  ["oversized XML whitespace", call("\u00a0".repeat(129)), "after"],
  ["oversized XML parameters", oversizedXml, "after"],
])("strips %s from visible text", (_name, block, after) => {
  expect(strip(`before\n${block}\n${after}`)).toBe(`before\n${after}`);
});
it("does not promote oversized XML parameters to a call", () => {
  expect(parseTool(oversizedXml)).toBeNull();
});
