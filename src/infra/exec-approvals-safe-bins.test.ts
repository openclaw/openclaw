// Covers safe-bin allowlist behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlistWithAuthorization,
  isSafeBinUsage,
  normalizeSafeBins,
  resolveSafeBins,
} from "./exec-approvals.js";
import { resolveSafeBinProfiles } from "./exec-safe-bin-policy.js";
import { getTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

describe("exec approvals safe bins", () => {
  type SafeBinCase = {
    name: string;
    argv: string[];
    expected: boolean;
    safeBinProfiles?: Readonly<Record<string, { minPositional?: number; maxPositional?: number }>>;
  };

  const deniedFlags: [string, string][] = [
    ["sort", "-oblocked"],
    ["sort", "--output=blocked"],
    ["sort", "--compress-program=blocked"],
    ["sort", "--compress-prog=blocked"],
    ["sort", "--files0-fro=blocked"],
    ["sort", "--random-source=blocked"],
    ["sort", "--temporary-directory=blocked"],
    ["sort", "-Tblocked"],
    ["grep", "-R"],
    ["grep", "--recursive"],
    ["grep", "--file=blocked"],
    ["jq", "-fblocked"],
    ["jq", "--from-file=blocked"],
    ["wc", "--files0-from=blocked"],
    ["wc", "--files0-fro=blocked"],
  ];

  const cases: SafeBinCase[] = [
    {
      name: "blocks jq safe bins even with non-path args",
      argv: ["jq", ".foo"],
      expected: false,
    },
    {
      name: "blocks jq env builtin even when jq is explicitly opted in",
      argv: ["jq", "env"],
      expected: false,
    },
    {
      name: "blocks awk scripts even when awk is explicitly profiled",
      argv: ["awk", 'BEGIN { system("id") }'],
      expected: false,
      safeBinProfiles: { awk: {} },
    },
    {
      name: "blocks sed scripts even when sed is explicitly profiled",
      argv: ["sed", "e"],
      expected: false,
      safeBinProfiles: { sed: {} },
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin value tokens",
      argv: ["head", "-c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}"],
      expected: false,
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin long option values",
      argv: ["head", "--bytes=${IFS}16"],
      expected: false,
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin positional tokens",
      argv: ["tr", "${IFS}", "_"],
      expected: false,
    },
    ...deniedFlags.map(([bin, flag]) => ({
      name: `blocks ${bin} ${flag}`,
      argv: [bin, flag],
      expected: false,
    })),
    {
      name: "blocks grep file positional when pattern uses -e",
      argv: ["grep", "-e", "needle", ".env"],
      expected: false,
    },
    {
      name: "blocks grep file positional after -- terminator",
      argv: ["grep", "-e", "needle", "--", ".env"],
      expected: false,
    },
    {
      name: "rejects unknown long options in safe-bin mode",
      argv: ["sort", "--totally-unknown=1"],
      expected: false,
    },
    {
      name: "rejects ambiguous long-option abbreviations in safe-bin mode",
      argv: ["sort", "--f=1"],
      expected: false,
    },
    {
      name: "rejects unknown short options in safe-bin mode",
      argv: ["tr", "-S", "a", "b"],
      expected: false,
    },
    {
      name: "keeps tail -fn 1 follow mode approval-gated",
      argv: ["tail", "-fn", "1"],
      expected: false,
    },
    {
      name: "auto-allows cut only-delimited mode with a field selector",
      argv: ["cut", "-s", "-f", "1"],
      expected: true,
    },
    {
      name: "auto-allows head quiet mode",
      argv: ["head", "-q"],
      expected: true,
    },
    {
      name: "auto-allows tail quiet mode",
      argv: ["tail", "-q"],
      expected: true,
    },
    {
      name: "auto-allows wc line count via boolean flag",
      argv: ["wc", "-l"],
      expected: true,
    },
    {
      name: "auto-allows wc word count via boolean long flag",
      argv: ["wc", "--words"],
      expected: true,
    },
    {
      name: "auto-allows uniq count via boolean flag",
      argv: ["uniq", "-c"],
      expected: true,
    },
    {
      name: "auto-allows tr delete via boolean flag",
      argv: ["tr", "-d", "abc"],
      expected: true,
    },
  ];

  it.runIf(process.platform !== "win32").each(cases)("$name", (testCase) => {
    const executableName = testCase.argv[0]!;
    const ok = isSafeBinUsage({
      argv: testCase.argv,
      resolution: {
        kind: "executable",
        rawExecutable: executableName,
        resolvedPath: `/usr/bin/${executableName}`,
        executableName,
      },
      safeBins: normalizeSafeBins([executableName]),
      safeBinProfiles: testCase.safeBinProfiles,
      // This table isolates argv policy. Dedicated cases below exercise real path trust.
      isTrustedSafeBinPathFn: () => true,
    });
    expect(ok).toBe(testCase.expected);
  });

  it("checks safe-bin trusted dirs against the real executable identity", () => {
    if (process.platform === "win32") {
      return;
    }
    const resolution = {
      kind: "executable" as const,
      rawExecutable: "head",
      resolvedPath: "/opt/homebrew/bin/head",
      resolvedRealPath: "/opt/homebrew/Cellar/coreutils/9.5/bin/head",
      executableName: "head",
    };
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/opt/homebrew/bin"]),
      }),
    ).toBe(false);
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: ["/opt/homebrew/Cellar/coreutils/9.5/bin"],
          refresh: true,
        }),
      }),
    ).toBe(true);
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/tmp/other-bin"]),
      }),
    ).toBe(false);
  });

  it("supports injected platform for deterministic safe-bin checks", () => {
    const ok = isSafeBinUsage({
      argv: ["head", "-n", "1"],
      resolution: {
        kind: "executable",
        rawExecutable: "head",
        resolvedPath: "/usr/bin/head",
        executableName: "head",
      },
      safeBins: normalizeSafeBins(["head"]),
      platform: "win32",
    });
    expect(ok).toBe(false);
  });

  it("supports injected trusted path checker for deterministic callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const baseParams = {
      argv: ["head", "-n", "1"],
      resolution: {
        kind: "executable" as const,
        rawExecutable: "head",
        resolvedPath: "/tmp/custom/head",
        executableName: "head",
      },
      safeBins: normalizeSafeBins(["head"]),
    };
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => true,
      }),
    ).toBe(true);
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => false,
      }),
    ).toBe(false);
  });

  it("does not include sort/grep in default safeBins", () => {
    const defaults = resolveSafeBins(undefined);
    expect(defaults.has("jq")).toBe(false);
    expect(defaults.has("sort")).toBe(false);
    expect(defaults.has("grep")).toBe(false);
  });

  it("does not auto-allow unprofiled safe-bin entries", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluateShellAllowlistWithAuthorization({
      command: "python3 -c \"print('owned')\"",
      allowlist: [],
      safeBins: normalizeSafeBins(["python3"]),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("allows caller-defined custom safe-bin profiles", () => {
    if (process.platform === "win32") {
      return;
    }
    const safeBinProfiles = resolveSafeBinProfiles({
      echo: {
        maxPositional: 1,
      },
    });
    const allow = isSafeBinUsage({
      argv: ["echo", "hello"],
      resolution: {
        kind: "executable",
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
    });
    const deny = isSafeBinUsage({
      argv: ["echo", "hello", "world"],
      resolution: {
        kind: "executable",
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
    });
    expect(allow).toBe(true);
    expect(deny).toBe(false);
  });

  it("threads trusted safe-bin dirs through allowlist evaluation", () => {
    if (process.platform === "win32") {
      return;
    }
    const analysis = {
      ok: true as const,
      segments: [
        {
          raw: "head -n 1",
          argv: ["head", "-n", "1"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "head",
              resolvedPath: "/custom/bin/head",
              executableName: "head",
            }),
          }),
        },
      ],
    };
    const denied = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/usr/bin"]),
      cwd: "/tmp",
    });
    expect(denied.allowlistSatisfied).toBe(false);

    const allowed = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
      cwd: "/tmp",
    });
    expect(allowed.allowlistSatisfied).toBe(true);
  });

  it("does not auto-trust PATH-shadowed safe bins without explicit trusted dirs", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = makeExecApprovalsTempDir();
    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeHead = path.join(fakeDir, "head");
    fs.writeFileSync(fakeHead, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeHead, 0o755);

    const result = await evaluateShellAllowlistWithAuthorization({
      command: "head -n 1",
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      env: makePathEnv(fakeDir),
      cwd: tmp,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.execution.resolvedPath).toBe(fakeHead);
  });

  it("fails closed for semantic env wrappers in allowlist mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluateShellAllowlistWithAuthorization({
      command: "env -S 'sh -c \"echo pwned\"' tr",
      allowlist: [{ pattern: "/usr/bin/tr" }],
      safeBins: normalizeSafeBins(["tr"]),
      cwd: "/tmp",
      platform: process.platform,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.policyBlocked).toBe(true);
  });
});
