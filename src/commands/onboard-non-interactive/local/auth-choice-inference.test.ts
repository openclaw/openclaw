import { describe, expect, it } from "vitest";
import { inferAuthChoiceFromFlags } from "./auth-choice-inference.js";

describe("inferAuthChoiceFromFlags", () => {
  it("infers edgee auth choice from --edgee-api-key", () => {
    const inferred = inferAuthChoiceFromFlags({
      edgeeApiKey: "edgee-key",
    });
    expect(inferred.choice).toBe("edgee-api-key");
    expect(inferred.matches.some((m) => m.authChoice === "edgee-api-key")).toBe(true);
  });
});
