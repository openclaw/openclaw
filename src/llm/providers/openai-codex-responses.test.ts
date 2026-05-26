import { describe, expect, it } from "vitest";
import { extractOpenAICodexAccountId } from "./openai-codex-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("extractOpenAICodexAccountId", () => {
  it("decodes URL-safe base64 JWT payloads", () => {
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "w_ébé_1fzcswWN6Pi5zL",
      },
    });
    expect(accessToken.split(".")[1]).toContain("_");

    expect(extractOpenAICodexAccountId(accessToken)).toBe("w_ébé_1fzcswWN6Pi5zL");
  });

  it("rejects tokens without a Codex account id", () => {
    expect(() => extractOpenAICodexAccountId(createJwt({}))).toThrow(
      "Failed to extract accountId from token",
    );
  });
});
