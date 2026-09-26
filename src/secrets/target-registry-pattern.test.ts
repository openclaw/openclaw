/** Tests secret target registry pattern compile/match/expand behavior. */
import { describe, expect, it } from "vitest";
import {
  compileTargetRegistryEntry,
  matchPathTokens,
  materializePathTokens,
} from "./target-registry-pattern.js";

function compilePattern(pathPattern: string, refPathPattern?: string) {
  return compileTargetRegistryEntry({
    id: "test.pattern",
    targetType: "test.pattern",
    configFile: "openclaw.json",
    pathPattern,
    ...(refPathPattern ? { refPathPattern } : {}),
    secretShape: refPathPattern ? "sibling_ref" : "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  });
}

describe("target registry pattern helpers", () => {
  it("matches wildcard and array tokens with stable capture ordering", () => {
    const tokens = compilePattern("agents.list[].memory.search.providers.*.apiKey").pathTokens;
    const match = matchPathTokens(
      ["agents", "list", 2, "memory", "search", "providers", "openai", "apiKey"],
      tokens,
    );

    expect(match).toEqual({
      captures: [2, "openai"],
    });
    expect(
      matchPathTokens(
        ["agents", "list", "2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
        { allowLegacyArrayString: true },
      ),
    ).toEqual({ captures: [2, "openai"] });
    expect(
      matchPathTokens(
        ["agents", "list", "2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
  });

  it("materializes sibling ref paths from wildcard and array captures", () => {
    const refTokens = compilePattern(
      "agents.list[].memory.search.providers.*.apiKey",
      "agents.list[].memory.search.providers.*.apiKeyRef",
    ).refPathTokens;
    expect(refTokens).toBeDefined();
    expect(materializePathTokens(refTokens ?? [], [1, "anthropic"])).toEqual([
      "agents",
      "list",
      1,
      "memory",
      "search",
      "providers",
      "anthropic",
      "apiKeyRef",
    ]);
    expect(materializePathTokens(refTokens ?? [], ["1", "anthropic"])).toBeNull();
  });

  it("keeps wildcard record keys distinct from array indices without excluding arrays", () => {
    const tokens = compilePattern("accounts.*.token").pathTokens;

    expect(matchPathTokens(["accounts", "0", "token"], tokens)).toEqual({ captures: ["0"] });
    expect(matchPathTokens(["accounts", 0, "token"], tokens)).toEqual({ captures: [0] });
    expect(
      matchPathTokens(["accounts", 0, "token"], compilePattern("accounts.0.token").pathTokens),
    ).toBeNull();
  });

  it("normalizes legacy numeric strings only for declared array captures", () => {
    const arrayTokens = compilePattern("accounts[].token").pathTokens;
    const wildcardTokens = compilePattern("accounts.*.token").pathTokens;
    const options = { allowLegacyArrayString: true };

    expect(matchPathTokens(["accounts", "0", "token"], arrayTokens)).toBeNull();
    expect(matchPathTokens(["accounts", "0", "token"], arrayTokens, options)).toEqual({
      captures: [0],
    });
    expect(matchPathTokens(["accounts", "0", "token"], wildcardTokens, options)).toEqual({
      captures: ["0"],
    });
    for (const invalid of ["01", "+1", "4294967294"]) {
      expect(matchPathTokens(["accounts", invalid, "token"], arrayTokens, options)).toBeNull();
    }
  });

  it("materializes wildcard sibling ref paths with their original container shape", () => {
    const { pathTokens, refPathTokens } = compilePattern("accounts.*.token", "accounts.*.tokenRef");

    for (const segment of ["0", 0] as const) {
      const matched = matchPathTokens(["accounts", segment, "token"], pathTokens);

      expect(matched).not.toBeNull();
      expect(materializePathTokens(refPathTokens ?? [], matched!.captures)).toEqual([
        "accounts",
        segment,
        "tokenRef",
      ]);
    }
  });
});
