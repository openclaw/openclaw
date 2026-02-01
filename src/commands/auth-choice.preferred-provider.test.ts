import { describe, expect, it } from "vitest";

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps Nebius auth choice to nebius provider", () => {
    expect(resolvePreferredProviderForAuthChoice("nebius-api-key")).toBe("nebius");
  });
});
