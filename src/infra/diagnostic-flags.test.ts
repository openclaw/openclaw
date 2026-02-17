import { describe, expect, it } from "vitest";
import {
  isDiagnosticFlagEnabled,
  matchesDiagnosticFlag,
  resolveDiagnosticFlags,
} from "./diagnostic-flags.js";

describe("resolveDiagnosticFlags", () => {
  it("returns empty for no config or env", () => {
    expect(resolveDiagnosticFlags(undefined, {})).toEqual([]);
  });

  it("parses env flags", () => {
    expect(resolveDiagnosticFlags(undefined, { OPENCLAW_DIAGNOSTICS: "foo,bar" })).toEqual([
      "foo",
      "bar",
    ]);
  });

  it("treats 'true' as wildcard", () => {
    expect(resolveDiagnosticFlags(undefined, { OPENCLAW_DIAGNOSTICS: "true" })).toEqual(["*"]);
  });

  it("treats 'false' as disabled", () => {
    expect(resolveDiagnosticFlags(undefined, { OPENCLAW_DIAGNOSTICS: "false" })).toEqual([]);
  });

  it("deduplicates flags", () => {
    expect(resolveDiagnosticFlags(undefined, { OPENCLAW_DIAGNOSTICS: "foo,foo,bar" })).toEqual([
      "foo",
      "bar",
    ]);
  });
});

describe("matchesDiagnosticFlag", () => {
  it("matches exact flag", () => {
    expect(matchesDiagnosticFlag("debug", ["debug"])).toBe(true);
  });

  it("matches wildcard *", () => {
    expect(matchesDiagnosticFlag("anything", ["*"])).toBe(true);
  });

  it("matches 'all' as wildcard", () => {
    expect(matchesDiagnosticFlag("anything", ["all"])).toBe(true);
  });

  it("matches prefix wildcard", () => {
    expect(matchesDiagnosticFlag("provider.openai", ["provider*"])).toBe(true);
    expect(matchesDiagnosticFlag("other", ["provider*"])).toBe(false);
  });

  it("matches dot-star wildcard", () => {
    expect(matchesDiagnosticFlag("provider.openai", ["provider.*"])).toBe(true);
    expect(matchesDiagnosticFlag("provider", ["provider.*"])).toBe(true);
    expect(matchesDiagnosticFlag("providers", ["provider.*"])).toBe(false);
  });

  it("returns false for empty flag", () => {
    expect(matchesDiagnosticFlag("", ["debug"])).toBe(false);
  });

  it("case insensitive", () => {
    expect(matchesDiagnosticFlag("DEBUG", ["debug"])).toBe(true);
  });
});

describe("isDiagnosticFlagEnabled", () => {
  it("integrates config and env", () => {
    expect(isDiagnosticFlagEnabled("test", undefined, { OPENCLAW_DIAGNOSTICS: "test" })).toBe(true);
    expect(isDiagnosticFlagEnabled("other", undefined, { OPENCLAW_DIAGNOSTICS: "test" })).toBe(
      false,
    );
  });
});
