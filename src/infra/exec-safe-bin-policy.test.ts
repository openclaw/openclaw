// Covers safe-bin policy profiles, validation, and generated docs text.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  normalizeSafeBinProfileFixtures,
  resolveSafeBinProfiles,
  type SafeBinProfileFixtures,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

function safeProfile(bin: string) {
  return expectDefined(SAFE_BIN_PROFILES[bin], `${bin} profile`);
}

function readGeneratedDocBlock(name: string): string {
  const startMarker = `[//]: # "SAFE_BIN_${name}:START"`;
  const endMarker = `[//]: # "SAFE_BIN_${name}:END"`;
  const docs = fs.readFileSync(path.resolve("docs/tools/exec-approvals-advanced.md"), "utf8");
  const start = docs.indexOf(startMarker);
  const end = docs.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return docs.slice(start + startMarker.length, end).trim();
}

function buildDeniedFlagArgvVariants(flag: string): string[][] {
  if (flag.startsWith("--")) {
    return [[`${flag}=blocked`], [flag, "blocked"], [flag]];
  }
  if (flag.startsWith("-")) {
    return [[`${flag}blocked`], [flag, "blocked"], [flag]];
  }
  return [[flag]];
}

describe("exec safe bin policy", () => {
  it.each<[string, string[], boolean]>([
    ["grep", ["-e", "needle"], true],
    ["grep", ["--regexp=needle"], true],
    ["grep", ["needle"], false],
    ["grep", ["-e", "SECRET", ".env"], false],
    ["grep", ["--regexp", "KEY", "config.py"], false],
    ["grep", ["--regexp=KEY", ".env"], false],
    ["grep", ["-e", "KEY", "--", ".env"], false],
    ["sort", ["-S", "1M"], true],
    ["sort", ["--key=1,1"], true],
    ["sort", ["--ke=1,1"], true],
    ["sort", ["--key"], false],
    ["sort", ["--key", "./fields.txt"], false],
    ["sort", ["-S", "C:\\temp\\buffer"], false],
    ["sort", ["--compress-prog=sh"], false],
    ["sort", ["--files0-fro=list.txt"], false],
    ["sort", ["--totally-unknown=1"], false],
    ["sort", ["--f=1"], false],
    ["wc", ["--files0-fro=list.txt"], false],
    ["wc", ["--files0-fro", "list.txt"], false],
    ["wc", ["-l"], true],
    ["wc", ["-w"], true],
    ["wc", ["-lw"], true],
    ["uniq", ["-c"], true],
    ["tr", ["-d", "abc"], true],
    ["tr", ["-s", "abc"], true],
    ["wc", ["--lines"], true],
    ["wc", ["--max-line-length"], true],
    ["wc", ["--word"], true],
    ["wc", ["--lines=5"], false],
    ["tr", ["-S", "a", "b"], false],
    ["wc", ["-Z"], false],
    ["tail", ["-fn", "1"], false],
    ["uniq", ["-cf", "2"], true],
    ["grep", ["-e", "needle", "--", "../secret.txt"], false],
    ["grep", ["-e", "needle", "--", "*.txt"], false],
    ["grep", ["-e", "needle", "--", "-"], true],
  ])("%s validates %j as %s", (bin, argv, expected) => {
    expect(validateSafeBinArgv(argv, safeProfile(bin))).toBe(expected);
  });

  it.each([".foo", ".env", "env", "env.FOO", ".foo | env", "$ENV", "($ENV).OPENAI_API_KEY"])(
    "blocks jq filter %s in safe-bin mode",
    (program) => {
      expect(validateSafeBinArgv([program], safeProfile("jq"), { binName: "jq" })).toBe(false);
    },
  );

  it("does not let custom config profiles widen the boolean allowlist", () => {
    const customFixtures = {
      wc: { allowedBooleanFlags: ["-l"], deniedFlags: ["--files0-from"] },
    } as unknown as SafeBinProfileFixtures;
    const normalized = normalizeSafeBinProfileFixtures(customFixtures);
    expect(
      "allowedBooleanFlags" in expectDefined(normalized.wc, "normalized.wc test invariant"),
    ).toBe(false);
    const profiles = resolveSafeBinProfiles(normalized);
    expect(
      expectDefined(profiles.wc, "profiles.wc test invariant").allowedBooleanFlags?.size ?? 0,
    ).toBe(0);
    expect(
      validateSafeBinArgv(["-l"], expectDefined(profiles.wc, "profiles.wc test invariant")),
    ).toBe(false);
  });
});

describe("exec safe bin policy long-option metadata", () => {
  it("precomputes long-option prefix mappings for compiled profiles", () => {
    const sortProfile = safeProfile("sort");
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
});

describe("exec safe bin policy denied-flag matrix", () => {
  for (const [binName, profile] of Object.entries(SAFE_BIN_PROFILES)) {
    for (const deniedFlag of profile.deniedFlags ?? []) {
      for (const variant of buildDeniedFlagArgvVariants(deniedFlag)) {
        it(`${binName} denies ${deniedFlag} (${variant.join(" ")})`, () => {
          expect(validateSafeBinArgv(variant, profile, { binName })).toBe(false);
        });
      }
    }
  }
});

describe("exec safe bin policy docs parity", () => {
  it("keeps default safe-bin docs in sync with policy defaults", () => {
    const actual = readGeneratedDocBlock("DEFAULTS");
    const expected = DEFAULT_SAFE_BINS.map((bin) => `\`${bin}\``).join(", ");
    expect(actual).toBe(expected);
  });

  it("keeps denied-flag docs in sync with compiled policy profiles", () => {
    const actual = readGeneratedDocBlock("DENIED_FLAGS");
    const expected = Object.entries(SAFE_BIN_PROFILES)
      .flatMap(([bin, profile]) => {
        const deniedFlags = Array.from(profile.deniedFlags ?? []).toSorted();
        return deniedFlags.length === 0
          ? []
          : [`- \`${bin}\`: ${deniedFlags.map((flag) => `\`${flag}\``).join(", ")}`];
      })
      .toSorted()
      .join("\n");
    expect(actual).toBe(expected);
  });
});
