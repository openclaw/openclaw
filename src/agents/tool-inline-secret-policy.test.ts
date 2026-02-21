import { describe, expect, it } from "vitest";
import { findInlineToolSecretViolation } from "./tool-inline-secret-policy.js";

describe("tool inline secret policy", () => {
  it("flags apiKey fields", () => {
    const violation = findInlineToolSecretViolation({ apiKey: "sk_live_123" });
    expect(violation).toEqual({ key: "apiKey", path: "apiKey" });
  });

  it("flags nested oauth credential fields", () => {
    const violation = findInlineToolSecretViolation({
      oauth: {
        refreshToken: "r1",
      },
    });
    expect(violation).toEqual({ key: "refreshToken", path: "oauth.refreshToken" });
  });

  it("does not flag non-secret resource tokens", () => {
    const violation = findInlineToolSecretViolation({
      file_token: "filecnAABBCCDDEE",
      folder_token: "fldrAABBCCDDEE",
    });
    expect(violation).toBeNull();
  });

  it("does not flag generic key params used by non-secret tools", () => {
    const violation = findInlineToolSecretViolation({
      request: {
        key: "Enter",
      },
    });
    expect(violation).toBeNull();
  });

  it("supports emergency bypass env flag", () => {
    process.env.OPENCLAW_ALLOW_INLINE_TOOL_SECRETS = "1";
    try {
      const violation = findInlineToolSecretViolation({ password: "secret" });
      expect(violation).toBeNull();
    } finally {
      delete process.env.OPENCLAW_ALLOW_INLINE_TOOL_SECRETS;
    }
  });
});
