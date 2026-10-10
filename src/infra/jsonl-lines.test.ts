import { PassThrough, Readable } from "node:stream";
import { expect, it } from "vitest";
import { createJsonlLineReader } from "./jsonl-lines.js";

it("frames only LF, preserving UTF-8 split at every byte and final EOF", async () => {
  const records = [JSON.stringify({ text: "雪🦀\u0085NEL\u2028LS\u2029PS" }), '{"end":true}'];
  const bytes = Buffer.from(records.join("\n"));
  const input = Readable.from([...bytes].map((byte) => Buffer.from([byte])));
  const lines = createJsonlLineReader(input);
  const actual: string[] = [];
  for await (const line of lines) {
    actual.push(line);
  }
  expect(actual).toEqual(records);
});

it("preserves CRLF JSON whitespace and empty LF records", async () => {
  const lines = createJsonlLineReader(Readable.from(['{"first":1}\r\n\n{"last":2}\n']));
  const actual: string[] = [];
  for await (const line of lines) {
    actual.push(line);
  }
  expect(actual).toEqual(['{"first":1}', "", '{"last":2}']);
});

it("dispatches complete IPC records concurrently and stops without emitting an incomplete record", async () => {
  const input = new PassThrough();
  const lines = createJsonlLineReader(input);
  const actual: string[] = [];
  lines.on("data", (line: string) => actual.push(line));
  input.write('{"text":"left\u2028\u2029right"}\n{"second":true}\n{"unfinished":');
  expect(actual).toEqual(['{"text":"left\u2028\u2029right"}', '{"second":true}']);
  const closed = new Promise<void>((resolve) => {
    lines.once("close", resolve);
  });
  lines.close();
  await closed;
  input.write("true}\n");
  expect(actual).toHaveLength(2);
  expect(input.listenerCount("error")).toBe(0);
  input.destroy();
});

it("propagates the owning input error to an async reader", async () => {
  const input = new PassThrough();
  const lines = createJsonlLineReader(input);
  const next = lines[Symbol.asyncIterator]().next();
  const error = new Error("synthetic input failure");
  input.destroy(error);
  await expect(next).rejects.toBe(error);
});

it("delivers a final unterminated IPC record before one native close notification", async () => {
  const input = new PassThrough();
  const lines = createJsonlLineReader(input);
  const events: string[] = [];
  lines.on("data", (line: string) => events.push(line));
  const closed = new Promise<void>((resolve) => {
    lines.once("close", resolve);
  });
  lines.on("close", () => events.push("closed"));
  input.end('{"text":"雪\u2028\u2029"}');
  await closed;
  expect(events).toEqual(['{"text":"雪\u2028\u2029"}', "closed"]);
  expect(input.listenerCount("error")).toBe(0);
});
