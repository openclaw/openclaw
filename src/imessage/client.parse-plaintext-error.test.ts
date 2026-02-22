import { describe, expect, it } from "vitest";
import { parseIMessageRpcPlaintextError } from "./client.js";

describe("parseIMessageRpcPlaintextError", () => {
  it("returns null for non-error text", () => {
    expect(parseIMessageRpcPlaintextError('{"jsonrpc":"2.0"}')).toBeNull();
    expect(parseIMessageRpcPlaintextError("some random log line")).toBeNull();
  });

  it("parses permissionDenied lines with quoted paths", () => {
    const err = parseIMessageRpcPlaintextError(
      'permissionDenied(path: "/Users/alice/Library/Messages/chat.db", underlying: authorization denied (code: 23))',
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("imsg permission denied");
    expect(err?.message).toContain("/Users/alice/Library/Messages/chat.db");
    expect(err?.message).toContain("authorization denied (code: 23)");
    expect(err?.message).toContain("Full Disk Access");
  });

  it("parses permissionDenied lines with unquoted paths", () => {
    const err = parseIMessageRpcPlaintextError(
      "permissionDenied(path: /Users/bot/Library/Messages/chat.db, underlying: authorization denied (code: 23))",
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("/Users/bot/Library/Messages/chat.db");
  });
});
