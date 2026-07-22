// Parse and bound JSON object inputs for `openclaw mcp call`.
import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

export const MCP_CALL_INPUT_MAX_BYTES = 1024 * 1024;

export type McpCallInputOptions = {
  input?: string;
  inputFile?: string;
};

export type McpCallInputParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpCallJsonObject(raw: string, sourceLabel: string): McpCallInputParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${sourceLabel} must contain one JSON object.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: `${sourceLabel} must be valid JSON containing exactly one object.`,
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: `${sourceLabel} must be a JSON object, not an array or scalar.`,
    };
  }
  return { ok: true, value };
}

async function readBoundedStdin(maxBytes = MCP_CALL_INPUT_MAX_BYTES): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--input-file - refuses to read from an interactive terminal; pipe a JSON object or pass --input.",
    );
  }
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes,
    onOverflow: ({ maxBytes: limit }) => new Error(`MCP call input exceeds ${limit} bytes.`),
  });
  return bytes.toString("utf8");
}

async function readBoundedInputFile(
  filePath: string,
  maxBytes = MCP_CALL_INPUT_MAX_BYTES,
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    return (await readFileDescriptorBounded(handle.fd, maxBytes)).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Resolve tool arguments for `openclaw mcp call`.
 * Omitted input means `{}`. Exactly one of `--input` or `--input-file` may be set.
 * `--input-file -` reads one JSON object from stdin.
 */
export async function resolveMcpCallInput(
  opts: McpCallInputOptions,
): Promise<McpCallInputParseResult> {
  const inline = normalizeStringifiedOptionalString(opts.input);
  const file = normalizeStringifiedOptionalString(opts.inputFile);
  if (inline !== undefined && file !== undefined) {
    return {
      ok: false,
      error: "Specify only one of --input or --input-file.",
    };
  }
  if (inline === undefined && file === undefined) {
    return { ok: true, value: {} };
  }
  if (inline !== undefined) {
    if (Buffer.byteLength(inline, "utf8") > MCP_CALL_INPUT_MAX_BYTES) {
      return {
        ok: false,
        error: `MCP call input exceeds ${MCP_CALL_INPUT_MAX_BYTES} bytes.`,
      };
    }
    return parseMcpCallJsonObject(inline, "--input");
  }
  const filePath = file as string;
  try {
    const raw = filePath === "-" ? await readBoundedStdin() : await readBoundedInputFile(filePath);
    return parseMcpCallJsonObject(raw, filePath === "-" ? "stdin" : "--input-file");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("exceeds")) {
      return { ok: false, error: message };
    }
    if (filePath === "-") {
      return { ok: false, error: message };
    }
    return {
      ok: false,
      error: `Failed to read --input-file ${filePath}: ${message}`,
    };
  }
}
