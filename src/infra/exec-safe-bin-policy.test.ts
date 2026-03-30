import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILE_FIXTURES,
  SAFE_BIN_PROFILES,
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  renderDefaultSafeBinsDocText,
  renderSafeBinDeniedFlagsDocBullets,
  resolveSafeBinProfiles,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

const SAFE_BIN_DOC_DEFAULTS_START = '[//]: # "SAFE_BIN_DEFAULTS:START"';
const SAFE_BIN_DOC_DEFAULTS_END = '[//]: # "SAFE_BIN_DEFAULTS:END"';
const SAFE_BIN_DOC_DENIED_FLAGS_START = '[//]: # "SAFE_BIN_DENIED_FLAGS:START"';
const SAFE_BIN_DOC_DENIED_FLAGS_END = '[//]: # "SAFE_BIN_DENIED_FLAGS:END"';

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

describe("exec safe bin policy jq", () => {
  const jqProfile = SAFE_BIN_PROFILES.jq;

  it("allows normal jq field filters", () => {
    expect(validateSafeBinArgv([".foo"], jqProfile, { binName: "jq" })).toBe(true);
    expect(validateSafeBinArgv([".env"], jqProfile, { binName: "jq" })).toBe(true);
  });

  it("blocks jq env builtin filters in safe-bin mode", () => {
    expect(validateSafeBinArgv(["env"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["env.FOO"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv([".foo | env"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["$ENV"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["($ENV).OPENAI_API_KEY"], jqProfile, { binName: "jq" })).toBe(
      false,
    );
  });
});

describe("exec safe bin policy sort", () => {
  const sortProfile = SAFE_BIN_PROFILES.sort;

  it("allows stdin-only sort flags", () => {
    expect(validateSafeBinArgv(["-S", "1M"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--key=1,1"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--ke=1,1"], sortProfile)).toBe(true);
  });

  it("rejects missing or path-like values for allowed flags", () => {
    expect(validateSafeBinArgv(["--key"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--key", "./fields.txt"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["-S", "C:\\temp\\buffer"], sortProfile)).toBe(false);
  });

  it("blocks sort --compress-program in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-program=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--compress-program", "sh"], sortProfile)).toBe(false);
  });

  it("blocks denied long-option abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-prog=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], sortProfile)).toBe(false);
  });

  it("rejects unknown or ambiguous long options in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--totally-unknown=1"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--f=1"], sortProfile)).toBe(false);
  });
});

describe("exec safe bin policy wc", () => {
  const wcProfile = SAFE_BIN_PROFILES.wc;

  it("blocks wc --files0-from abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], wcProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro", "list.txt"], wcProfile)).toBe(false);
  });
});

describe("exec safe bin policy token hygiene", () => {
  it("rejects path-like and glob positional tokens after the terminator", () => {
    const grepProfile = SAFE_BIN_PROFILES.grep;
    expect(validateSafeBinArgv(["-e", "needle", "--", "../secret.txt"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "needle", "--", "*.txt"], grepProfile)).toBe(false);
  });

  it("keeps stdin marker after the terminator non-positional", () => {
    const grepProfile = SAFE_BIN_PROFILES.grep;
    expect(validateSafeBinArgv(["-e", "needle", "--", "-"], grepProfile)).toBe(true);
  });
});

describe("exec safe bin policy long-option metadata", () => {
  it("precomputes long-option prefix mappings for compiled profiles", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    expect(sortProfile.knownLongFlagsSet?.has("--compress-program")).toBe(true);
    expect(sortProfile.longFlagPrefixMap?.get("--compress-prog")).toBe("--compress-program");
    expect(sortProfile.longFlagPrefixMap?.get("--f")).toBe(null);
  });

  it("preserves behavior when profile metadata is missing and rebuilt at runtime", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    const withoutMetadata = {
      ...sortProfile,
      knownLongFlags: undefined,
      knownLongFlagsSet: undefined,
      longFlagPrefixMap: undefined,
    };
    expect(validateSafeBinArgv(["--compress-prog=sh"], withoutMetadata)).toBe(false);
    expect(validateSafeBinArgv(["--totally-unknown=1"], withoutMetadata)).toBe(false);
  });

  it("builds prefix maps from collected long flags", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    const flags = collectKnownLongFlags(
      sortProfile.allowedValueFlags ?? new Set(),
      sortProfile.deniedFlags ?? new Set(),
    );
    const prefixMap = buildLongFlagPrefixMap(flags);
    expect(prefixMap.get("--compress-pr")).toBe("--compress-program");
    expect(prefixMap.get("--f")).toBe(null);
  });
});

describe("exec safe bin policy knownLongFlags from config", () => {
  it("accepts known boolean long flags provided via fixture knownLongFlags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        knownLongFlags: ["--version", "--verbose", "--help"],
      },
    });
    const profile = profiles.mycli;
    // Boolean flags (no value) should be accepted when declared as known
    expect(validateSafeBinArgv(["--version"], profile)).toBe(true);
    expect(validateSafeBinArgv(["--verbose"], profile)).toBe(true);
  });

  it("rejects inline values on known flags not in allowedValueFlags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        knownLongFlags: ["--mode"],
      },
    });
    const profile = profiles.mycli;
    // --mode is known but not in allowedValueFlags, so inline value is rejected
    expect(validateSafeBinArgv(["--mode=production"], profile)).toBe(false);
  });

  it("rejects unknown long flags even when knownLongFlags is provided", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        knownLongFlags: ["--mode"],
      },
    });
    const profile = profiles.mycli;
    expect(validateSafeBinArgv(["--unknown-flag"], profile)).toBe(false);
  });

  it("merges knownLongFlags with flags derived from allowedValueFlags and deniedFlags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        allowedValueFlags: ["--output"],
        deniedFlags: ["--exec"],
        knownLongFlags: ["--verbose"],
      },
    });
    const profile = profiles.mycli;
    expect(profile.knownLongFlagsSet?.has("--output")).toBe(true);
    expect(profile.knownLongFlagsSet?.has("--exec")).toBe(true);
    expect(profile.knownLongFlagsSet?.has("--verbose")).toBe(true);
  });

  it("supports GNU abbreviation for user-provided knownLongFlags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        knownLongFlags: ["--verbose"],
      },
    });
    const profile = profiles.mycli;
    // GNU abbreviation: --verb should resolve to --verbose
    expect(validateSafeBinArgv(["--verb"], profile)).toBe(true);
  });

  it("filters user knownLongFlags that are strict prefixes of denied flags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        deniedFlags: ["--recursive"],
        knownLongFlags: ["--rec", "--recu"],
      },
    });
    const profile = profiles.mycli;
    // Prefix forms must not bypass --recursive denial
    expect(validateSafeBinArgv(["--rec"], profile)).toBe(false);
    expect(validateSafeBinArgv(["--recu"], profile)).toBe(false);
    // Full form still denied via deniedFlags
    expect(validateSafeBinArgv(["--recursive"], profile)).toBe(false);
    // Filtered prefixes must not appear in knownLongFlagsSet
    expect(profile.knownLongFlagsSet?.has("--rec")).toBe(false);
    expect(profile.knownLongFlagsSet?.has("--recu")).toBe(false);
  });

  it("keeps user knownLongFlags that are not prefixes of denied flags", () => {
    const profiles = resolveSafeBinProfiles({
      mycli: {
        deniedFlags: ["--recursive"],
        knownLongFlags: ["--verbose", "--version"],
      },
    });
    const profile = profiles.mycli;
    expect(validateSafeBinArgv(["--verbose"], profile)).toBe(true);
    expect(validateSafeBinArgv(["--version"], profile)).toBe(true);
  });

  it("works identically to auto-derivation when knownLongFlags duplicates allow/deny", () => {
    const withExplicit = resolveSafeBinProfiles({
      mycli: {
        allowedValueFlags: ["--output"],
        deniedFlags: ["--exec"],
        knownLongFlags: ["--output", "--exec"],
      },
    });
    const withoutExplicit = resolveSafeBinProfiles({
      mycli: {
        allowedValueFlags: ["--output"],
        deniedFlags: ["--exec"],
      },
    });
    expect(withExplicit.mycli.knownLongFlagsSet).toEqual(withoutExplicit.mycli.knownLongFlagsSet);
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
  it("keeps default safe-bin docs in sync with policy defaults", () => {
    const docsPath = path.resolve(process.cwd(), "docs/tools/exec-approvals.md");
    const docs = fs.readFileSync(docsPath, "utf8").replaceAll("\r\n", "\n");
    const start = docs.indexOf(SAFE_BIN_DOC_DEFAULTS_START);
    const end = docs.indexOf(SAFE_BIN_DOC_DEFAULTS_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const actual = docs.slice(start + SAFE_BIN_DOC_DEFAULTS_START.length, end).trim();
    const expected = renderDefaultSafeBinsDocText(DEFAULT_SAFE_BINS);
    expect(actual).toBe(expected);
  });

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
