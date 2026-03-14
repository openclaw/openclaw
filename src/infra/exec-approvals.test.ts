import { describe, expect, it } from "vitest";
import { normalizeSafeBins } from "./exec-approvals-allowlist.js";
import {
  ABSOLUTE_MAX_TRUST_MINUTES,
  DEFAULT_MAX_TRUST_MINUTES,
  evaluateExecAllowlist,
  getTrustWindow,
  grantTrustWindow,
  initTrustWindowCache,
  resolveExecApprovalsFromFile,
  revokeTrustWindow,
  type ExecAllowlistEntry,
} from "./exec-approvals.js";

describe("exec approvals allowlist evaluation", () => {
  function evaluateAutoAllowSkills(params: {
    analysis: {
      ok: boolean;
      segments: Array<{
        raw: string;
        argv: string[];
        resolution: {
          rawExecutable: string;
          executableName: string;
          resolvedPath?: string;
        };
      }>;
    };
    resolvedPath: string;
  }) {
    return evaluateExecAllowlist({
      analysis: params.analysis,
      allowlist: [],
      safeBins: new Set(),
      skillBins: [{ name: "skill-bin", resolvedPath: params.resolvedPath }],
      autoAllowSkills: true,
      cwd: "/tmp",
    });
  }

  function expectAutoAllowSkillsMiss(result: ReturnType<typeof evaluateExecAllowlist>): void {
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
  }

  it("satisfies allowlist on exact match", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "tool",
          argv: ["tool"],
          resolution: {
            rawExecutable: "tool",
            resolvedPath: "/usr/bin/tool",
            executableName: "tool",
          },
        },
      ],
    };
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/tool" }];
    const result = evaluateExecAllowlist({
      analysis,
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
  });

  it("satisfies allowlist via safe bins", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "jq .foo",
          argv: ["jq", ".foo"],
          resolution: {
            rawExecutable: "jq",
            resolvedPath: "/usr/bin/jq",
            executableName: "jq",
          },
        },
      ],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches).toEqual([]);
  });

  it("satisfies allowlist via auto-allow skills", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "skill-bin",
          argv: ["skill-bin", "--help"],
          resolution: {
            rawExecutable: "skill-bin",
            resolvedPath: "/opt/skills/skill-bin",
            executableName: "skill-bin",
          },
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("does not satisfy auto-allow skills for explicit relative paths", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "./skill-bin",
          argv: ["./skill-bin", "--help"],
          resolution: {
            rawExecutable: "./skill-bin",
            resolvedPath: "/tmp/skill-bin",
            executableName: "skill-bin",
          },
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/tmp/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("does not satisfy auto-allow skills when command resolution is missing", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "skill-bin --help",
          argv: ["skill-bin", "--help"],
          resolution: {
            rawExecutable: "skill-bin",
            executableName: "skill-bin",
          },
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("returns empty segment details for chain misses", () => {
    const segment = {
      raw: "tool",
      argv: ["tool"],
      resolution: {
        rawExecutable: "tool",
        resolvedPath: "/usr/bin/tool",
        executableName: "tool",
      },
    };
    const analysis = {
      ok: true,
      segments: [segment],
      chains: [[segment]],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: "/usr/bin/other" }],
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.allowlistMatches).toEqual([]);
    expect(result.segmentSatisfiedBy).toEqual([]);
  });

  it("aggregates segment satisfaction across chains", () => {
    const allowlistSegment = {
      raw: "tool",
      argv: ["tool"],
      resolution: {
        rawExecutable: "tool",
        resolvedPath: "/usr/bin/tool",
        executableName: "tool",
      },
    };
    const safeBinSegment = {
      raw: "jq .foo",
      argv: ["jq", ".foo"],
      resolution: {
        rawExecutable: "jq",
        resolvedPath: "/usr/bin/jq",
        executableName: "jq",
      },
    };
    const analysis = {
      ok: true,
      segments: [allowlistSegment, safeBinSegment],
      chains: [[allowlistSegment], [safeBinSegment]],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: "/usr/bin/tool" }],
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
    expect(result.segmentSatisfiedBy).toEqual(["allowlist", "safeBins"]);
  });
});

describe("trust window", () => {
  it("overrides resolved agent policy while active", () => {
    initTrustWindowCache();
    const granted = grantTrustWindow({ agentId: "main", minutes: 5 });
    expect(granted.ok).toBe(true);

    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        agents: {
          main: {
            security: "deny",
            ask: "always",
          },
        },
      },
      agentId: "main",
    });
    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("off");
  });

  it("does not stack active trust windows", () => {
    initTrustWindowCache();
    expect(grantTrustWindow({ agentId: "main", minutes: 5 }).ok).toBe(true);
    const duplicate = grantTrustWindow({ agentId: "main", minutes: 5 });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error).toContain("already active");
    }
  });

  it("enforces default and absolute trust duration caps", () => {
    initTrustWindowCache();
    const aboveDefault = grantTrustWindow({
      agentId: "main",
      minutes: DEFAULT_MAX_TRUST_MINUTES + 1,
    });
    expect(aboveDefault.ok).toBe(false);

    const forced = grantTrustWindow({
      agentId: "main",
      minutes: DEFAULT_MAX_TRUST_MINUTES + 1,
      force: true,
    });
    expect(forced.ok).toBe(true);
    initTrustWindowCache();

    const aboveAbsolute = grantTrustWindow({
      agentId: "main",
      minutes: ABSOLUTE_MAX_TRUST_MINUTES + 1,
      force: true,
    });
    expect(aboveAbsolute.ok).toBe(false);
  });

  it("ignores expired trust windows during policy resolution", () => {
    initTrustWindowCache();
    const granted = grantTrustWindow({ agentId: "main", minutes: 1 });
    expect(granted.ok).toBe(true);
    const trustWindow = getTrustWindow("main");
    expect(trustWindow).toBeTruthy();
    if (!trustWindow) {
      return;
    }
    trustWindow.expiresAt = Date.now() - 1000;

    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        agents: {
          main: {
            security: "allowlist",
            ask: "on-miss",
          },
        },
      },
      agentId: "main",
    });
    expect(resolved.agent.security).toBe("allowlist");
    expect(resolved.agent.ask).toBe("on-miss");
  });

  it("revokes active trust windows", () => {
    initTrustWindowCache();
    expect(grantTrustWindow({ agentId: "main", minutes: 5 }).ok).toBe(true);
    const revoked = revokeTrustWindow({ agentId: "main" });
    expect(revoked.ok).toBe(true);
    expect(getTrustWindow("main")).toBeUndefined();
  });
});
