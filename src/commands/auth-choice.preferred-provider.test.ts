import { describe, expect, it } from "vitest";
import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps edgee-api-key to edgee provider", () => {
    expect(resolvePreferredProviderForAuthChoice("edgee-api-key")).toBe("edgee");
  });
});
