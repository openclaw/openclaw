import { describe, expect, it } from "vitest";
import { formatIMessageRpcProtocolError } from "./client.js";

describe("formatIMessageRpcProtocolError", () => {
  it("explains non-JSON permissionDenied output from imsg", () => {
    const error = formatIMessageRpcProtocolError(
      'permissionDenied(path: "/Users/bot/Library/Messages/chat.db", underlying: authorization denied (code: 23))',
      "Unexpected token 'p'",
    );

    expect(error.message).toContain("permission denied");
    expect(error.message).toContain("Full Disk Access");
  });

  it("preserves unexpected non-JSON output details", () => {
    const error = formatIMessageRpcProtocolError("hello", "Unexpected token 'h'");

    expect(error.message).toBe("imsg rpc emitted non-JSON output: hello (Unexpected token 'h')");
  });
});
