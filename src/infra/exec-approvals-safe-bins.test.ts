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
import { resolveSafeBinProfiles, type SafeBinProfile } from "./exec-safe-bin-policy.js";
import { getTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

function evaluateSafeBinApproval(
  params: {
    argv: string[];
    resolution?: ExecutableResolution;
  } & Partial<
    Pick<
      Parameters<typeof evaluateExecAllowlist>[0],
      "safeBins" | "platform" | "trustedSafeBinDirs" | "safeBinProfiles" | "cwd"
    >
  >,
): boolean {
  const executableName = params.argv[0]!;
  const result = evaluateExecAllowlist({
    ...params,
    safeBins: params.safeBins ?? resolveSafeBins([executableName]),
    allowlist: [],
    analysis: {
      ok: true,
      segments: [
        {
          raw: params.argv.join(" "),
          argv: params.argv,
          resolution: makeMockCommandResolution({
            execution: params.resolution ?? {
              kind: "executable",
              rawExecutable: executableName,
              resolvedPath: `/usr/bin/${executableName}`,
              resolvedRealPath: `/usr/bin/${executableName}`,
              executableName,
            },
          }),
        },
      ],
    },
  });
  return result.allowlistSatisfied;
}

describe("exec approvals safe bins", () => {
  it.runIf(process.platform !== "win32").each([
    ["blocks explicitly profiled sed scripts", ["sed", "e"], false, { sed: {} }],
    ["blocks expansion in long options", ["head", "--bytes=${IFS}16"], false],
    ["blocks expansion in positional tokens", ["tr", "${IFS}", "_"], false],
    ["blocks abbreviated file-reading options", ["wc", "--files0-fro=blocked"], false],
    ["blocks files after --", ["grep", "-e", "needle", "--", ".env"], false],
    ["rejects unknown short options", ["tr", "-S", "a", "b"], false],
    ["keeps follow mode approval-gated", ["tail", "-fn", "1"], false],
    ["allows boolean long flags", ["wc", "--words"], true],
  ] satisfies Array<[string, string[], boolean, { sed: SafeBinProfile }?]>)(
    "%s",
    (_name, argv, expected, safeBinProfiles?: { sed: SafeBinProfile }) => {
      const ok = evaluateSafeBinApproval({
        argv,
        safeBinProfiles,
        trustedSafeBinDirs: new Set(["/usr/bin"]),
      });
      expect(ok).toBe(expected);
    },
  );

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
    const params = { argv: ["head", "-n", "1"], resolution, safeBins: resolveSafeBins(["head"]) };
    for (const [trustedSafeBinDirs, expected] of [
      [new Set(["/opt/homebrew/bin"]), false],
      [getTrustedSafeBinDirs({ extraDirs: ["/opt/homebrew/Cellar/coreutils/9.5/bin"] }), true],
      [new Set(["/tmp/other-bin"]), false],
    ] as const) {
      expect(evaluateSafeBinApproval({ ...params, trustedSafeBinDirs })).toBe(expected);
    }
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
    expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: false });
  });

  it("allows caller-defined custom safe-bin profiles", () => {
    if (process.platform === "win32") {
      return;
    }
    const safeBinProfiles = resolveSafeBinProfiles({
      echo: { maxPositional: 1 },
    });
    const params = {
      resolution: {
        kind: "executable" as const,
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: resolveSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
    };
    expect(evaluateSafeBinApproval({ ...params, argv: ["echo", "hello"] })).toBe(true);
    expect(evaluateSafeBinApproval({ ...params, argv: ["echo", "hello", "world"] })).toBe(false);
  });

  it("threads trusted safe-bin dirs through allowlist evaluation", () => {
    if (process.platform === "win32") {
      return;
    }
    const params = {
      argv: ["head", "-n", "1"],
      cwd: "/tmp",
      resolution: makeMockExecutableResolution({
        rawExecutable: "head",
        resolvedPath: "/custom/bin/head",
        executableName: "head",
      }),
    };
    expect(evaluateSafeBinApproval({ ...params, trustedSafeBinDirs: new Set(["/usr/bin"]) })).toBe(
      false,
    );
    expect(
      evaluateSafeBinApproval({ ...params, trustedSafeBinDirs: new Set(["/custom/bin"]) }),
    ).toBe(true);
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
    expect(result).toMatchObject({
      analysisOk: true,
      allowlistSatisfied: false,
      segmentSatisfiedBy: [null],
    });
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
    expect(result).toMatchObject({
      analysisOk: true,
      allowlistSatisfied: false,
      segmentSatisfiedBy: [null],
    });
    expect(result.segments[0]?.resolution?.policyBlocked).toBe(true);
  });
});
