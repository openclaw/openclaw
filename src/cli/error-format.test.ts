import { describe, expect, it } from "vitest";
import { parseConfigSetValue } from "./config-cli-path.js";

function readStrictJsonFailure(value: string): string {
  try {
    parseConfigSetValue(value, true);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("Expected strict JSON parsing to fail");
}

describe("parseConfigSetValue strict JSON failures", () => {
  it("offers file-based recovery for invalid JSON", () => {
    const message = readStrictJsonFailure("[telegram:123456]");

    expect(message).toContain("openclaw config patch --file <path> --dry-run");
    expect(message).toContain("JSON5 config patch object");
    expect(message).toContain("For plain strings, omit --strict-json.");
  });
  it("keeps the bounded JSON preview UTF-16 well-formed", () => {
    const value = `${"x".repeat(44)}🚀tail`;

    const message = readStrictJsonFailure(value);

    expect(message).toContain(`${"x".repeat(44)}...`);
    expect(message).not.toContain("\uD83D");
  });
});
