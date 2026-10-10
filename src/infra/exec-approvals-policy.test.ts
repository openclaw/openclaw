// Tests execution approval policy matching and persistence.
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/config.js";
import { LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import type { ExecApprovalsFile } from "./exec-approvals.js";
import { buildCwdBoundHashedArgPattern } from "./exec-command-resolution.js";

vi.unmock("./exec-approvals.js");
vi.unmock("./exec-approvals-effective.js");

let collectExecPolicyScopeSnapshots: typeof import("./exec-approvals-effective.js").collectExecPolicyScopeSnapshots;
let resolveExecPolicyScopeSnapshot: typeof import("./exec-approvals-effective.js").resolveExecPolicyScopeSnapshot;
let evaluateExecAllowlist: typeof import("./exec-approvals.js").evaluateExecAllowlist;
let hasDurableExecApproval: typeof import("./exec-approvals.js").hasDurableExecApproval;
let requireValidExecTarget: typeof import("./exec-approvals.js").requireValidExecTarget;
let normalizeExecMode: typeof import("./exec-approvals.js").normalizeExecMode;
let normalizeExecTarget: typeof import("./exec-approvals.js").normalizeExecTarget;
let normalizeExecSecurity: typeof import("./exec-approvals.js").normalizeExecSecurity;
let requiresExecApproval: typeof import("./exec-approvals.js").requiresExecApproval;
let normalizeExecApprovalUnavailableDecisions: typeof import("./exec-approvals.js").normalizeExecApprovalUnavailableDecisions;
let resolveExecApprovalUnavailableDecisions: typeof import("./exec-approvals.js").resolveExecApprovalUnavailableDecisions;
let resolveExecApprovalRequestAllowedDecisions: typeof import("./exec-approvals.js").resolveExecApprovalRequestAllowedDecisions;
let resolveExactExecModeFromPolicy: typeof import("./exec-approvals.js").resolveExactExecModeFromPolicy;
let resolveExecModePolicy: typeof import("./exec-approvals.js").resolveExecModePolicy;
let resolveExecPolicyForMode: typeof import("./exec-approvals.js").resolveExecPolicyForMode;

async function loadActualExecApprovalModules(): Promise<void> {
  vi.resetModules();
  const execApprovals =
    await vi.importActual<typeof import("./exec-approvals.js")>("./exec-approvals.js");
  const effective = await vi.importActual<typeof import("./exec-approvals-effective.js")>(
    "./exec-approvals-effective.js",
  );
  collectExecPolicyScopeSnapshots = effective.collectExecPolicyScopeSnapshots;
  resolveExecPolicyScopeSnapshot = effective.resolveExecPolicyScopeSnapshot;
  evaluateExecAllowlist = execApprovals.evaluateExecAllowlist;
  hasDurableExecApproval = execApprovals.hasDurableExecApproval;
  requireValidExecTarget = execApprovals.requireValidExecTarget;
  normalizeExecMode = execApprovals.normalizeExecMode;
  normalizeExecTarget = execApprovals.normalizeExecTarget;
  normalizeExecSecurity = execApprovals.normalizeExecSecurity;
  requiresExecApproval = execApprovals.requiresExecApproval;
  normalizeExecApprovalUnavailableDecisions =
    execApprovals.normalizeExecApprovalUnavailableDecisions;
  resolveExecApprovalUnavailableDecisions = execApprovals.resolveExecApprovalUnavailableDecisions;
  resolveExecApprovalRequestAllowedDecisions =
    execApprovals.resolveExecApprovalRequestAllowedDecisions;
  resolveExactExecModeFromPolicy = execApprovals.resolveExactExecModeFromPolicy;
  resolveExecModePolicy = execApprovals.resolveExecModePolicy;
  resolveExecPolicyForMode = execApprovals.resolveExecPolicyForMode;
}

function summarizeExecPolicyScopeSnapshot(
  params: Parameters<typeof resolveExecPolicyScopeSnapshot>[0],
): Omit<ReturnType<typeof resolveExecPolicyScopeSnapshot>, "allowedDecisions"> {
  const { allowedDecisions: _allowedDecisions, ...summary } =
    resolveExecPolicyScopeSnapshot(params);
  return summary;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toEqual(expect.objectContaining(expected));
}

function expectMalformedAgentAskUsesDefaults(agentAsk: unknown): void {
  const approvals = {
    version: 1,
    defaults: {
      ask: "always",
    },
    agents: {
      runner: {
        ask: agentAsk,
      },
    },
  } as unknown as ExecApprovalsFile;
  const summary = summarizeExecPolicyScopeSnapshot({
    approvals,
    globalExecConfig: {
      ask: "off",
    },
    configPath: "agents.entries.runner.tools.exec",
    scopeLabel: "agent:runner",
    agentId: "runner",
  });

  expectFields(summary.ask, {
    requested: "off",
    host: "always",
    hostSource: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config defaults.ask",
    effective: "always",
    note: "more aggressive ask wins",
  });
}

describe("exec approvals policy helpers", () => {
  beforeAll(async () => {
    // Reload once to isolate this suite from facade mocks left by other test files.
    await loadActualExecApprovalModules();
  });

  it.each([{ raw: " auto ", expected: "auto" }])(
    "normalizes exec target value %j",
    ({ raw, expected }) => {
      expect(normalizeExecTarget(raw)).toBe(expected);
    },
  );

  it("requires direct exec target requests to use the closed host set", () => {
    expect(requireValidExecTarget(" gateway ")).toBe("gateway");
    expect(requireValidExecTarget("")).toBe(null);
    expect(requireValidExecTarget(undefined)).toBe(null);
    expect(() => requireValidExecTarget("spark-ff13")).toThrow(
      'Invalid exec host "spark-ff13". Allowed values: auto, sandbox, gateway, node.',
    );
    expect(() => requireValidExecTarget(42)).toThrow(
      "Invalid exec host value type number. Allowed values: auto, sandbox, gateway, node.",
    );
  });

  it.each([
    { raw: "FULL", expected: "full" },
    { raw: "unknown", expected: null },
  ])("normalizes exec security value %j", ({ raw, expected }) => {
    expect(normalizeExecSecurity(raw)).toBe(expected);
  });

  it.each([
    { raw: " auto ", expected: "auto" },
    { raw: "maybe", expected: null },
  ])("normalizes exec mode value %j", ({ raw, expected }) => {
    expect(normalizeExecMode(raw)).toBe(expected);
  });

  it.each([
    { security: "full" as const, ask: "off" as const, expected: "full" as const },
    { security: "full" as const, ask: "on-miss" as const, expected: null },
    { security: "full" as const, ask: "always" as const, expected: null },
  ])("resolves the exact exec mode for legacy policy %j", ({ security, ask, expected }) => {
    expect(resolveExactExecModeFromPolicy({ security, ask })).toBe(expected);
  });

  it.each([
    {
      mode: "allowlist" as const,
      expected: { security: "allowlist" as const, ask: "off" as const, autoReview: false },
    },
    {
      mode: "ask" as const,
      expected: { security: "allowlist" as const, ask: "on-miss" as const, autoReview: false },
    },
    {
      mode: "full" as const,
      expected: { security: "full" as const, ask: "off" as const, autoReview: false },
    },
  ])("maps explicit exec mode to effective policy %j", ({ mode, expected }) => {
    expect(resolveExecPolicyForMode(mode)).toEqual(expected);
  });

  it("preserves legacy security and ask when no explicit mode is set", () => {
    expect(
      resolveExecModePolicy({
        security: "full",
        ask: "always",
      }),
    ).toEqual({
      mode: "ask",
      security: "full",
      ask: "always",
      autoReview: false,
    });
  });

  it("treats unavailable request decisions as optional approvals only", () => {
    expect(
      normalizeExecApprovalUnavailableDecisions(["allow-once", "deny", "allow-always", "bad"]),
    ).toEqual(["allow-always"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "on-miss",
        unavailableDecisions: ["allow-always"],
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "on-miss",
        unavailableDecisions: ["allow-once", "deny", "allow-always", "bad"],
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "always",
        unavailableDecisions: ["allow-always"],
      }),
    ).toEqual(["allow-once", "deny"]);
  });

  it("derives unavailable optional decisions from effective approval policy", () => {
    expect(resolveExecApprovalUnavailableDecisions({ ask: "on-miss" })).toEqual([]);
    expect(resolveExecApprovalUnavailableDecisions({ ask: "always" })).toEqual(["allow-always"]);
    expect(
      resolveExecApprovalUnavailableDecisions({
        ask: "on-miss",
        allowAlwaysPersistence: { kind: "one-shot", reasons: ["no-reusable-pattern"] },
      }),
    ).toEqual(["allow-always"]);
  });

  it.each([
    {
      ask: "always" as const,
      security: "full" as const,
      analysisOk: true,
      allowlistSatisfied: false,
      durableApprovalSatisfied: true,
      expected: true,
    },
  ])("requiresExecApproval respects ask mode and allowlist satisfaction for %j", (testCase) => {
    expect(requiresExecApproval(testCase)).toBe(testCase.expected);
  });

  it("treats exact-command allow-always approvals as durable trust", () => {
    expect(
      hasDurableExecApproval({
        analysisOk: false,
        segmentAllowlistEntries: [],
        allowlist: [
          {
            pattern: "=command:613b5a60181648fd",
            source: "allow-always",
          },
        ],
        commandText: 'powershell -NoProfile -Command "Write-Output hi"',
      }),
    ).toBe(true);
  });

  it("marks policy-blocked segments as non-durable allowlist entries", () => {
    const executable = makeMockExecutableResolution({
      rawExecutable: "/usr/bin/echo",
      resolvedPath: "/usr/bin/echo",
      resolvedRealPath: "/usr/bin/echo",
      executableName: "echo",
    });
    const allowlist = [
      {
        pattern: "/usr/bin/echo",
        argPattern: buildCwdBoundHashedArgPattern(["/usr/bin/echo", "ok"], "/tmp"),
        source: "allow-always" as const,
      },
    ];
    const result = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          {
            raw: "/usr/bin/echo ok",
            argv: ["/usr/bin/echo", "ok"],
            resolution: makeMockCommandResolution({
              execution: executable,
            }),
          },
          {
            raw: "/bin/sh -lc whoami",
            argv: ["/bin/sh", "-lc", "whoami"],
            resolution: makeMockCommandResolution({
              execution: makeMockExecutableResolution({
                rawExecutable: "/bin/sh",
                resolvedPath: "/bin/sh",
                executableName: "sh",
              }),
              policyBlocked: true,
            }),
          },
        ],
      },
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
      platform: process.platform,
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toHaveLength(2);
    expectFields(result.segmentAllowlistEntries[0], { pattern: "/usr/bin/echo" });
    expect(result.segmentAllowlistEntries[1]).toBeNull();
    expect(
      hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
        allowlist,
      }),
    ).toBe(false);
  });

  it("maps normalized requested mode into policy snapshots", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      scopeExecConfig: {
        mode: "auto",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expectFields(summary.mode, {
      requested: "auto",
      requestedSource: "tools.exec.mode",
      effective: "auto",
      note: "requested mode applies",
    });
    expectFields(summary.security, {
      requested: "allowlist",
      requestedSource: "tools.exec.mode",
      effective: "allowlist",
    });
    expectFields(summary.ask, {
      requested: "on-miss",
      requestedSource: "tools.exec.mode",
      effective: "on-miss",
    });
  });

  it("lets narrower legacy policy override a global normalized mode in snapshots", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      globalExecConfig: {
        mode: "deny",
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "agents.entries.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expectFields(summary.mode, {
      requested: "full",
      requestedSource:
        "derived from agents.entries.runner.tools.exec.security and agents.entries.runner.tools.exec.ask",
      effective: "full",
    });
    expectFields(summary.security, {
      requested: "full",
      requestedSource: "agents.entries.runner.tools.exec.security",
      effective: "full",
    });
  });

  it("uses OPENCLAW_STATE_DIR when reporting default host sources", () => {
    const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = path.join(process.cwd(), ".tmp-openclaw-state");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const summary = summarizeExecPolicyScopeSnapshot({
        approvals: {
          version: 1,
          defaults: {
            security: "allowlist",
          },
        },
        scopeExecConfig: {
          security: "full",
        },
        configPath: "tools.exec",
        scopeLabel: "tools.exec",
      });

      expect(summary.security.hostSource).toBe(
        `${path.join(stateDir, "state", "openclaw.sqlite#exec_approvals_config")} defaults.security`,
      );
    } finally {
      if (originalOpenClawStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
      }
    }
  });

  it("does not let host ask=off suppress a stricter requested ask", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
        defaults: {
          ask: "off",
        },
      },
      scopeExecConfig: {
        ask: "always",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expectFields(summary.ask, {
      requested: "always",
      host: "off",
      effective: "always",
      note: "requested ask applies",
    });
  });

  it("clamps askFallback to the effective security", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
        defaults: {
          security: "full",
          ask: "always",
          askFallback: "full",
        },
      },
      scopeExecConfig: {
        security: "allowlist",
        ask: "always",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "allowlist",
      source: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config defaults.askFallback",
    });
  });

  it("skips malformed host fields when attributing their source", () => {
    expectMalformedAgentAskUsesDefaults("foo");
  });

  it("attributes host policy to wildcard agent entries before defaults", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "*": {
            security: "allowlist",
            ask: "always",
            askFallback: "deny",
          },
        },
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "agents.entries.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expectFields(summary.security, {
      host: "allowlist",
      hostSource: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config agents.*.security",
    });
    expectFields(summary.ask, {
      host: "always",
      hostSource: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config agents.*.ask",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config agents.*.askFallback",
    });
  });

  it("uses host-reported defaults instead of requested policy fallbacks", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: { version: 1, agents: {} },
      scopeExecConfig: { security: "full", ask: "off" },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
      hostDefaults: {
        security: "deny",
        ask: "on-miss",
        askFallback: "deny",
      },
      hostDefaultSource: "node-reported resolved defaults",
    });

    expectFields(summary.security, {
      requested: "full",
      host: "deny",
      hostSource: "node-reported resolved defaults",
      effective: "deny",
    });
    expectFields(summary.ask, {
      requested: "off",
      host: "on-miss",
      hostSource: "node-reported resolved defaults",
      effective: "on-miss",
    });
    expect(summary.askFallback.source).toBe("node-reported resolved defaults");
  });

  it("collects global, configured-agent, and approvals-only agent scopes", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      cfg: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
        agents: {
          entries: { runner: {} },
        },
      } satisfies OpenClawConfig,
      approvals: {
        version: 1,
        agents: {
          runner: {
            security: "allowlist",
          },
          batch: {
            ask: "always",
          },
        },
      },
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec", "agent:batch"]);
    expectFields(snapshots[1]?.ask, {
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
    expectFields(snapshots[0]?.security, {
      requested: "full",
      requestedSource: "tools.exec.security",
      host: "allowlist",
      effective: "allowlist",
    });
  });

  it("keeps the default agent scope when main has an explicit exec override", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      cfg: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
        agents: {
          entries: {
            [DEFAULT_AGENT_ID]: {
              tools: {
                exec: {
                  ask: "always",
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      approvals: {
        version: 1,
      },
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec", "agent:main"]);
    expectFields(snapshots[1]?.ask, {
      requested: "always",
      requestedSource: "agents.entries.main.tools.exec.ask",
    });
  });
});
