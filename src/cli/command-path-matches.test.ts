// Command path match tests cover CLI command path matching and normalization.
import { describe, expect, it } from "vitest";
import { matchesArgvCommandPath, matchesCommandPath } from "./command-path-matches.js";

describe("command-path-matches", () => {
  it("matches prefix and exact command paths", () => {
    expect(matchesCommandPath(["status"], ["status"])).toBe(true);
    expect(matchesCommandPath(["status", "watch"], ["status"])).toBe(true);
    expect(matchesCommandPath(["status", "watch"], ["status"], { exact: true })).toBe(false);
    expect(matchesCommandPath(["config", "get"], ["config", "get"], { exact: true })).toBe(true);
  });

  it("matches exact argv command paths without mistaking option values for subcommands", () => {
    const matchOptions = {
      exact: true,
      booleanFlags: ["--verbose"],
      valueFlags: ["--url", "--session"],
    } as const;

    expect(
      matchesArgvCommandPath(
        ["node", "openclaw", "acp", "--url", "wss://gateway.example.test"],
        ["acp"],
        matchOptions,
      ),
    ).toBe(true);
    expect(
      matchesArgvCommandPath(
        ["node", "openclaw", "acp", "--session", "client"],
        ["acp"],
        matchOptions,
      ),
    ).toBe(true);
    expect(
      matchesArgvCommandPath(
        ["node", "openclaw", "acp", "--verbose", "client"],
        ["acp"],
        matchOptions,
      ),
    ).toBe(false);
  });
});
