import { describe, expect, it } from "vitest";
import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps Nebius Token Factory auth choice", () => {
    expect(resolvePreferredProviderForAuthChoice("nebius-token-factory-api-key")).toBe(
      "nebius-token-factory",
    );
  });
});
