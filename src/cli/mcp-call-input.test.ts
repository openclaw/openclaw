import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMcpCallInput } from "./mcp-call-input.js";

describe("mcp call input parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a JSON object and rejects arrays, scalars, and empty input", async () => {
    await expect(resolveMcpCallInput({ input: '{"q":1}' })).resolves.toEqual({
      ok: true,
      value: { q: 1 },
    });
    await expect(resolveMcpCallInput({ input: "[1]" })).resolves.toEqual({
      ok: false,
      error: "--input must be a JSON object, not an array or scalar.",
    });
    await expect(resolveMcpCallInput({ input: "true" })).resolves.toEqual({
      ok: false,
      error: "--input must be a JSON object, not an array or scalar.",
    });
    // Whitespace-only --input is normalized away and treated as omitted input.
    await expect(resolveMcpCallInput({ input: "   " })).resolves.toEqual({
      ok: true,
      value: {},
    });
    await expect(resolveMcpCallInput({ input: "{" })).resolves.toMatchObject({ ok: false });
  });

  it("defaults omitted input to an empty object and rejects conflicting flags", async () => {
    await expect(resolveMcpCallInput({})).resolves.toEqual({ ok: true, value: {} });
    await expect(resolveMcpCallInput({ input: "{}", inputFile: "-" })).resolves.toEqual({
      ok: false,
      error: "Specify only one of --input or --input-file.",
    });
  });

  it("bounds oversized inline input and reads stdin for --input-file -", async () => {
    const oversized = `{"q":"${"x".repeat(1024 * 1024)}}`;
    await expect(resolveMcpCallInput({ input: oversized })).resolves.toEqual({
      ok: false,
      error: "MCP call input exceeds 1048576 bytes.",
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
