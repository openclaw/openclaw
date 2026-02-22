import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAFE_BIN_PROFILE_FIXTURES,
  SAFE_BIN_PROFILES,
  renderSafeBinDeniedFlagsDocBullets,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

const SAFE_BIN_DOC_DENIED_FLAGS_START = "<!-- SAFE_BIN_DENIED_FLAGS:START -->";
const SAFE_BIN_DOC_DENIED_FLAGS_END = "<!-- SAFE_BIN_DENIED_FLAGS:END -->";

function buildDeniedFlagArgvVariants(flag: string): string[][] {
  const value = "blocked";
  if (flag.startsWith("--")) {
    return [[`${flag}=${value}`], [flag, value], [flag]];
  }
  if (flag.startsWith("-")) {
    return [[`${flag}${value}`], [flag, value], [flag]];
  }
  return [[flag]];
}

describe("exec safe bin policy grep", () => {
  const grepProfile = SAFE_BIN_PROFILES.grep;

  it("allows stdin-only grep when pattern comes from flags", () => {
    expect(validateSafeBinArgv(["-e", "needle"], grepProfile)).toBe(true);
    expect(validateSafeBinArgv(["--regexp=needle"], grepProfile)).toBe(true);
  });

  it("blocks grep positional pattern form to avoid filename ambiguity", () => {
    expect(validateSafeBinArgv(["needle"], grepProfile)).toBe(false);
  });

  it("blocks file positionals when pattern comes from -e/--regexp", () => {
    expect(validateSafeBinArgv(["-e", "SECRET", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp", "KEY", "config.py"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp=KEY", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "KEY", "--", ".env"], grepProfile)).toBe(false);
  });
});

describe("exec safe bin policy sort", () => {
  const sortProfile = SAFE_BIN_PROFILES.sort;

  it("allows stdin-only sort flags", () => {
    expect(validateSafeBinArgv(["-S", "1M"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--key=1,1"], sortProfile)).toBe(true);
  });

  it("blocks sort --compress-program in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-program=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--compress-program", "sh"], sortProfile)).toBe(false);
  });
});

describe("exec safe bin policy denied-flag matrix", () => {
  for (const [binName, fixture] of Object.entries(SAFE_BIN_PROFILE_FIXTURES)) {
    const profile = SAFE_BIN_PROFILES[binName];
    const deniedFlags = fixture.deniedFlags ?? [];
    for (const deniedFlag of deniedFlags) {
      const variants = buildDeniedFlagArgvVariants(deniedFlag);
      for (const variant of variants) {
        it(`${binName} denies ${deniedFlag} (${variant.join(" ")})`, () => {
          expect(validateSafeBinArgv(variant, profile)).toBe(false);
        });
      }
    }
  }
});

describe("exec safe bin policy docs parity", () => {
  it("keeps denied-flag docs in sync with policy fixtures", () => {
    const docsPath = path.resolve(process.cwd(), "docs/tools/exec-approvals.md");
    const docs = fs.readFileSync(docsPath, "utf8").replaceAll("\r\n", "\n");
    const start = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_START);
    const end = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const actual = docs.slice(start + SAFE_BIN_DOC_DENIED_FLAGS_START.length, end).trim();
    const expected = renderSafeBinDeniedFlagsDocBullets();
    expect(actual).toBe(expected);
  });
});
