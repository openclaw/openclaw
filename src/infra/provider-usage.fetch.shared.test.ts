import { describe, expect, it } from "vitest";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
} from "./provider-usage.fetch.shared.js";

describe("provider usage fetch shared helpers", () => {
  it("builds a provider error snapshot", () => {
    expect(buildUsageErrorSnapshot("zai", "API error")).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: "API error",
    });
  });

  it("maps configured status codes to token expired", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "openai-codex",
      status: 401,
      tokenExpiredStatuses: [401, 403],
    });

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("includes trimmed API error messages in HTTP errors", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 403,
      message: " missing scope ",
    });

    expect(snapshot.error).toBe("HTTP 403: missing scope");
  });
});
