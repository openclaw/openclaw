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
  resolveSafeBins,
} from "./exec-approvals.js";
import type { ExecutableResolution } from "./exec-command-resolution.js";
import { resolveSafeBinProfiles } from "./exec-safe-bin-policy.js";
import { getTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

function evaluateSafeBinApproval(
  params: {
    argv: string[];
    resolution: ExecutableResolution;
  } & Pick<
    Parameters<typeof evaluateExecAllowlist>[0],
    "safeBins" | "platform" | "trustedSafeBinDirs" | "safeBinProfiles"
  >,
): boolean {
  const result = evaluateExecAllowlist({
    ...params,
    allowlist: [],
    analysis: {
      ok: true,
      segments: [
        {
          raw: params.argv.join(" "),
          argv: params.argv,
          resolution: makeMockCommandResolution({ execution: params.resolution }),
        },
      ],
    },
  });
  return result.allowlistSatisfied;
}

describe("exec approvals safe bins", () => {
  type SafeBinCase = {
    name: string;
    argv: string[];
    expected: boolean;
    safeBinProfiles?: Readonly<Record<string, { minPositional?: number; maxPositional?: number }>>;
  };

  const cases: SafeBinCase[] = [
    {
      name: "blocks sed scripts even when sed is explicitly profiled",
      argv: ["sed", "e"],
      expected: false,
      safeBinProfiles: { sed: {} },
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
    {
      name: "blocks wc --files0-fro=blocked",
      argv: ["wc", "--files0-fro=blocked"],
      expected: false,
    },
    {
      name: "blocks grep file positional after -- terminator",
      argv: ["grep", "-e", "needle", "--", ".env"],
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
      name: "auto-allows wc word count via boolean long flag",
      argv: ["wc", "--words"],
      expected: true,
    },
  ];

  it.runIf(process.platform !== "win32").each(cases)("$name", (testCase) => {
    const executableName = testCase.argv[0]!;
    const ok = evaluateSafeBinApproval({
      argv: testCase.argv,
      resolution: {
        kind: "executable",
        rawExecutable: executableName,
        resolvedPath: `/usr/bin/${executableName}`,
        resolvedRealPath: `/usr/bin/${executableName}`,
        executableName,
      },
      safeBins: resolveSafeBins([executableName]),
      safeBinProfiles: testCase.safeBinProfiles,
      trustedSafeBinDirs: new Set(["/usr/bin"]),
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
      evaluateSafeBinApproval({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: resolveSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/opt/homebrew/bin"]),
      }),
    ).toBe(false);
    expect(
      evaluateSafeBinApproval({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: resolveSafeBins(["head"]),
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: ["/opt/homebrew/Cellar/coreutils/9.5/bin"],
        }),
      }),
    ).toBe(true);
    expect(
      evaluateSafeBinApproval({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: resolveSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/tmp/other-bin"]),
      }),
    ).toBe(false);
  });

  it("supports injected platform for deterministic safe-bin checks", () => {
    const ok = evaluateSafeBinApproval({
      argv: ["head", "-n", "1"],
      resolution: {
        kind: "executable",
        rawExecutable: "head",
        resolvedPath: "/usr/bin/head",
        executableName: "head",
      },
      safeBins: resolveSafeBins(["head"]),
      platform: "win32",
    });
    expect(ok).toBe(false);
  });

  it("does not auto-allow unprofiled safe-bin entries", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluateShellAllowlistWithAuthorization({
      command: "python3 -c \"print('owned')\"",
      allowlist: [],
      safeBins: resolveSafeBins(["python3"]),
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
    const allow = evaluateSafeBinApproval({
      argv: ["echo", "hello"],
      resolution: {
        kind: "executable",
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: resolveSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
    });
    const deny = evaluateSafeBinApproval({
      argv: ["echo", "hello", "world"],
      resolution: {
        kind: "executable",
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: resolveSafeBins(["echo"]),
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
      safeBins: resolveSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/usr/bin"]),
      cwd: "/tmp",
    });
    expect(denied.allowlistSatisfied).toBe(false);

    const allowed = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: resolveSafeBins(["head"]),
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
      safeBins: resolveSafeBins(["head"]),
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
      safeBins: resolveSafeBins(["tr"]),
      cwd: "/tmp",
      platform: process.platform,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.policyBlocked).toBe(true);
  });
});
