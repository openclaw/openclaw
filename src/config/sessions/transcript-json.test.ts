import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import {
  prepareCodeModeCheckpoint,
  persistCodeModeCheckpoint,
} from "../../agents/code-mode-checkpoint.js";
import { normalizeTranscriptJsonValue } from "./transcript-json.js";

it.each(["exec", "wait"])("shares admitted %s payloads across checkpoint stamping", (toolName) => {
  const message = {
    role: "toolResult",
    toolName,
    toolCallId: "synthetic-call",
    content: [{ type: "text", text: "output 🦞\ud800" }],
    details: { nested: { values: [null, 7, "retained output"] } },
  };
  prepareCodeModeCheckpoint(message, {});
  normalizeTranscriptJsonValue({ message }, "");
  const stamped = persistCodeModeCheckpoint(message, message);
  const expected = JSON.stringify({ ...message, __openclaw: { codeModeCheckpoint: null } });
  const persisted = normalizeTranscriptJsonValue(stamped, "") as typeof stamped;
  expect(JSON.stringify(persisted)).toBe(expected);
  expect(persisted.content).toBe(message.content);
  expect(persisted.details).toBe(message.details);
  expect(persisted).not.toBe(message);
  expect(Object.isFrozen(persisted)).toBe(false);
  expect(Object.isFrozen(persisted.content[0])).toBe(true);
  expect(message).not.toHaveProperty("__openclaw");
});

it("does not admit arbitrary frozen payloads when copying a checkpoint envelope", () => {
  const content = Object.freeze([{ type: "text", text: "unadmitted output" }]);
  Object.freeze(content[0]);
  const message = Object.freeze({
    role: "toolResult",
    toolName: "exec",
    toolCallId: "call",
    content,
  });
  prepareCodeModeCheckpoint(message, {});
  const stamped = persistCodeModeCheckpoint(message, message);
  const persisted = normalizeTranscriptJsonValue(stamped, "") as typeof stamped;
  expect(persisted.content).toEqual(content);
  expect(persisted.content).not.toBe(content);
  expect(persisted.content[0]).not.toBe(content[0]);
  expect(message).not.toHaveProperty("__openclaw");
});

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
  ["wrappers", () => [Object(7), Object("text"), Object(false), Object(Symbol("hidden"))]],
  ["proxy", () => new Proxy({ value: 7 }, {})],
  [
    "messages",
    () => [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thought" },
          {
            type: "toolCall",
            id: "call",
            name: "exec",
            arguments: { nested: [null, true, { missing: undefined, value: -0 }] },
          },
        ],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "result\ud800" }],
        details: { values: [undefined, Number.NaN] },
      },
    ],
  ],
] as const)("matches native JSON bytes for %s", (_name, createValue) => {
  const value = createValue();
  const expected = JSON.stringify({ data: value });
  expect(JSON.stringify({ data: normalizeTranscriptJsonValue(value, "data") })).toBe(expected);
});

it("omits an own __proto__ member whose toJSON returns undefined", () => {
  const value = { ["__proto__"]: { toJSON: () => undefined } };
  expect(JSON.stringify(value)).toBe("{}");
  const normalized = normalizeTranscriptJsonValue(value, "data");
  expect(normalized).toEqual({});
  expect(Object.getOwnPropertyDescriptor(normalized, "__proto__")).toBeUndefined();
  expect(JSON.stringify(normalized)).toBe("{}");
});

it("retains ordinary shared JSON and unchanged frozen containers", () => {
  const values = [null, true, "text", 7];
  const shared = { values };
  const value = { first: shared, second: shared };
  expect(normalizeTranscriptJsonValue(value, "data")).toBe(value);
  expect(value.first).toBe(shared);
  expect(value.second).toBe(shared);
  expect(shared.values).toBe(values);
  const block = { text: "shared transcript text" };
  const nested = { content: [block, block] };
  expect(normalizeTranscriptJsonValue(nested, "data")).toBe(nested);
  expect(nested.content[0]).toBe(block);
  expect(nested.content[1]).toBe(block);
  const frozen = Object.freeze({ nested: Object.freeze({ value: 7 }) });
  expect(normalizeTranscriptJsonValue(frozen, "data")).toBe(frozen);
});

it("copies changed frozen containers without changing the source", () => {
  const source = { nested: { omitted: undefined, values: [undefined, -0] } };
  Object.freeze(source.nested.values);
  Object.freeze(source.nested);
  Object.freeze(source);
  const normalized = normalizeTranscriptJsonValue(source, "data");
  expect(normalized).toEqual({ nested: { values: [null, 0] } });
  expect(normalized).not.toBe(source);
  expect(source.nested).toHaveProperty("omitted", undefined);
  expect(source.nested.values).toEqual([undefined, -0]);
});
