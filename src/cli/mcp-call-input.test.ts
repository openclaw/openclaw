import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_CALL_INPUT_MAX_BYTES,
  parseMcpCallJsonObject,
  resolveMcpCallInput,
} from "./mcp-call-input.js";

describe("mcp call input parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a JSON object and rejects arrays, scalars, and empty input", () => {
    expect(parseMcpCallJsonObject('{"q":1}', "--input")).toEqual({
      ok: true,
      value: { q: 1 },
    });
    expect(parseMcpCallJsonObject("[1]", "--input")).toEqual({
      ok: false,
      error: "--input must be a JSON object, not an array or scalar.",
    });
    expect(parseMcpCallJsonObject("true", "--input")).toEqual({
      ok: false,
      error: "--input must be a JSON object, not an array or scalar.",
    });
    expect(parseMcpCallJsonObject("   ", "--input")).toEqual({
      ok: false,
      error: "--input must contain one JSON object.",
    });
    expect(parseMcpCallJsonObject("{", "--input").ok).toBe(false);
  });

  it("defaults omitted input to an empty object and rejects conflicting flags", async () => {
    await expect(resolveMcpCallInput({})).resolves.toEqual({ ok: true, value: {} });
    await expect(resolveMcpCallInput({ input: "{}", inputFile: "-" })).resolves.toEqual({
      ok: false,
      error: "Specify only one of --input or --input-file.",
    });
  });

  it("bounds oversized inline input and reads stdin for --input-file -", async () => {
    const oversized = `{"q":"${"x".repeat(MCP_CALL_INPUT_MAX_BYTES)}}`;
    await expect(resolveMcpCallInput({ input: oversized })).resolves.toEqual({
      ok: false,
      error: `MCP call input exceeds ${MCP_CALL_INPUT_MAX_BYTES} bytes.`,
    });

    const stream = Readable.from([Buffer.from('{"q":"stdin"}')]);
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Object.assign(stream, { isTTY: false }),
    });
    await expect(resolveMcpCallInput({ inputFile: "-" })).resolves.toEqual({
      ok: true,
      value: { q: "stdin" },
    });
  });
});
