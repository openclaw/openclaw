import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "../exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  normalizeSafeBins,
  resolveExecApprovalsFromFile,
  type ExecutableResolution,
} from "../exec-approvals.js";
import {
  resolveExecSafeBinRuntimePolicy,
  type ExecSafeBinConfigScope,
} from "../exec-safe-bin-runtime-policy.js";

function buildSegment(params: {
  argv: string[];
  executable: ExecutableResolution;
  effectiveArgv?: string[];
}) {
  return {
    raw: params.argv.join(" "),
    argv: params.argv,
    resolution: makeMockCommandResolution({
      execution: params.executable,
      effectiveArgv: params.effectiveArgv,
    }),
  };
}

describe.runIf(process.platform !== "win32")("Finn hybrid exec rollout", () => {
  const globalExecConfig: ExecSafeBinConfigScope = {
    safeBins: ["jq", "grep", "wc"],
    safeBinTrustedDirs: ["/usr/bin", "/usr/local/bin", "/home/finn/.nvm/versions/node/v22/bin"],
  };
  const localExecConfig: ExecSafeBinConfigScope = {
    safeBinTrustedDirs: ["/usr/libexec", "./scripts"],
  };
  const finnConfig = {
    tools: {
      exec: globalExecConfig,
    },
    agents: {
      list: [
        {
          id: "finn",
          tools: {
            exec: localExecConfig,
          },
        },
      ],
    },
  } as const;

  const finnApprovals = resolveExecApprovalsFromFile({
    agentId: "finn",
    file: {
      version: 1,
      agents: {
        finn: {
          allowlist: [
            { pattern: "/usr/bin/sqlite3" },
            { pattern: "/usr/bin/curl" },
            { pattern: "/home/finn/.nvm/**/bin/openclaw" },
          ],
        },
      },
    },
  });

  it("keeps Finn's safe-bin fast path limited to profiled low-risk tools in immutable dirs", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      global: finnConfig.tools.exec,
      local: finnConfig.agents.list[0].tools.exec,
    });

    expect([...policy.safeBins].toSorted()).toEqual(["grep", "jq", "wc"]);
    expect(policy.safeBins.has("sqlite3")).toBe(false);
    expect(policy.safeBins.has("curl")).toBe(false);
    expect(policy.safeBins.has("openclaw")).toBe(false);

    expect(policy.trustedSafeBinDirs.has("/bin")).toBe(true);
    expect(policy.trustedSafeBinDirs.has("/usr/bin")).toBe(true);
    expect(policy.trustedSafeBinDirs.has("/usr/libexec")).toBe(true);
    expect(policy.trustedSafeBinDirs.has("/usr/local/bin")).toBe(false);
    expect(policy.trustedSafeBinDirs.has("/home/finn/.nvm/versions/node/v22/bin")).toBe(false);
    expect(policy.trustedSafeBinDirs.has("./scripts")).toBe(false);
  });

  it("keeps sqlite3/curl/openclaw out of Finn's safe-bin fast path", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      global: finnConfig.tools.exec,
      local: finnConfig.agents.list[0].tools.exec,
    });

    expect(policy.safeBins.has("jq")).toBe(true);
    expect(policy.safeBins.has("grep")).toBe(true);
    expect(policy.safeBins.has("wc")).toBe(true);

    for (const command of [
      {
        argv: ["sqlite3", "/tmp/finn.db", "select 1"],
        resolvedPath: "/usr/bin/sqlite3",
        executableName: "sqlite3",
      },
      {
        argv: ["curl", "https://example.com"],
        resolvedPath: "/usr/bin/curl",
        executableName: "curl",
      },
      {
        argv: ["openclaw", "status"],
        resolvedPath: "/home/finn/.nvm/versions/node/v22.22.1/bin/openclaw",
        executableName: "openclaw",
      },
    ]) {
      const result = evaluateExecAllowlist({
        analysis: {
          ok: true,
          segments: [
            buildSegment({
              argv: command.argv,
              executable: makeMockExecutableResolution({
                rawExecutable: command.argv[0] ?? command.resolvedPath,
                resolvedPath: command.resolvedPath,
                executableName: command.executableName,
              }),
            }),
          ],
        },
        allowlist: [],
        safeBins: policy.safeBins,
        safeBinProfiles: policy.safeBinProfiles,
        trustedSafeBinDirs: policy.trustedSafeBinDirs,
        cwd: "/tmp",
        platform: "linux",
      });
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.segmentSatisfiedBy).toEqual([null]);
    }
  });

  it("allows Finn's mutable/runtime tools only through explicit path-based approvals", () => {
    const noSafeBins = normalizeSafeBins([]);
    const allowedCases = [
      {
        argv: ["sqlite3", "/tmp/finn.db", "select 1"],
        resolvedPath: "/usr/bin/sqlite3",
        expectedPattern: "/usr/bin/sqlite3",
      },
      {
        argv: ["curl", "https://api.example.com/health"],
        resolvedPath: "/usr/bin/curl",
        expectedPattern: "/usr/bin/curl",
      },
      {
        argv: ["openclaw", "system", "status"],
        resolvedPath: "/home/finn/.nvm/versions/node/v22.22.1/bin/openclaw",
        expectedPattern: "/home/finn/.nvm/**/bin/openclaw",
      },
    ];

    for (const testCase of allowedCases) {
      const result = evaluateExecAllowlist({
        analysis: {
          ok: true,
          segments: [
            buildSegment({
              argv: testCase.argv,
              executable: makeMockExecutableResolution({
                rawExecutable: testCase.argv[0] ?? testCase.resolvedPath,
                resolvedPath: testCase.resolvedPath,
                executableName: testCase.argv[0] ?? testCase.resolvedPath,
              }),
            }),
          ],
        },
        allowlist: finnApprovals.allowlist,
        safeBins: noSafeBins,
        cwd: "/tmp",
        platform: "linux",
      });

      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toEqual(["allowlist"]);
      expect(result.segmentAllowlistEntries[0]).toMatchObject({
        pattern: testCase.expectedPattern,
      });
    }

    const denied = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          buildSegment({
            argv: ["openclaw", "system", "status"],
            executable: makeMockExecutableResolution({
              rawExecutable: "openclaw",
              resolvedPath: "/tmp/fake-bin/openclaw",
              executableName: "openclaw",
            }),
          }),
        ],
      },
      allowlist: finnApprovals.allowlist,
      safeBins: noSafeBins,
      cwd: "/tmp",
      platform: "linux",
    });

    expect(denied.allowlistSatisfied).toBe(false);
    expect(denied.segmentSatisfiedBy).toEqual([null]);
  });
});
