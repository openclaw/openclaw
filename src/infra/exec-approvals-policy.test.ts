// Tests execution approval policy matching and persistence.
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/config.js";
import { LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { withEnv } from "../test-utils/env.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import type { ExecApprovalsFile } from "./exec-approvals.js";
import { buildCwdBoundHashedArgPattern } from "./exec-command-resolution.js";

vi.unmock("./exec-approvals.js");
vi.unmock("./exec-approvals-effective.js");

let execApprovals: typeof import("./exec-approvals.js");
let effective: typeof import("./exec-approvals-effective.js");

async function loadActualExecApprovalModules(): Promise<void> {
  vi.resetModules();
  execApprovals =
    await vi.importActual<typeof import("./exec-approvals.js")>("./exec-approvals.js");
  effective = await vi.importActual<typeof import("./exec-approvals-effective.js")>(
    "./exec-approvals-effective.js",
  );
}

type SnapshotParams = Parameters<typeof effective.resolveExecPolicyScopeSnapshot>[0];
function snapshot(
  params: Omit<SnapshotParams, "configPath" | "scopeLabel" | "approvals"> & {
    approvals?: ExecApprovalsFile;
  },
) {
  return effective.resolveExecPolicyScopeSnapshot({
    approvals: { version: 1 },
    configPath: params.agentId ? `agents.entries.${params.agentId}.tools.exec` : "tools.exec",
    scopeLabel: params.agentId ? `agent:${params.agentId}` : "tools.exec",
    ...params,
  });
}

function collectScopes(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  approvals: ExecApprovalsFile = { version: 1 },
) {
  return effective.collectExecPolicyScopeSnapshots({
    cfg: { tools: { exec: { security: "full", ask: "off" } }, agents: { entries } },
    approvals,
  });
}

describe("exec approvals policy helpers", () => {
  // Reload once to isolate this suite from facade mocks left by other test files.
  beforeAll(loadActualExecApprovalModules);

  it("normalizes exec target whitespace", () => {
    expect(execApprovals.normalizeExecTarget(" auto ")).toBe("auto");
  });

  it("requires direct exec target requests to use the closed host set", () => {
    expect(execApprovals.requireValidExecTarget(" gateway ")).toBe("gateway");
    expect(execApprovals.requireValidExecTarget("")).toBe(null);
    expect(execApprovals.requireValidExecTarget(undefined)).toBe(null);
    expect(() => execApprovals.requireValidExecTarget("spark-ff13")).toThrow(
      'Invalid exec host "spark-ff13". Allowed values: auto, sandbox, gateway, node.',
    );
    expect(() => execApprovals.requireValidExecTarget(42)).toThrow(
      "Invalid exec host value type number. Allowed values: auto, sandbox, gateway, node.",
    );
  });

  it.each([
    { raw: "FULL", expected: "full" },
    { raw: "unknown", expected: null },
  ])("normalizes exec security value %j", ({ raw, expected }) => {
    expect(execApprovals.normalizeExecSecurity(raw)).toBe(expected);
  });

  it.each([
    { raw: " auto ", expected: "auto" },
    { raw: "maybe", expected: null },
  ])("normalizes exec mode value %j", ({ raw, expected }) => {
    expect(execApprovals.normalizeExecMode(raw)).toBe(expected);
  });

  it.each([
    { security: "full" as const, ask: "off" as const, expected: "full" as const },
    { security: "full" as const, ask: "on-miss" as const, expected: null },
    { security: "full" as const, ask: "always" as const, expected: null },
  ])("resolves the exact exec mode for legacy policy %j", ({ security, ask, expected }) => {
    expect(execApprovals.resolveExactExecModeFromPolicy({ security, ask })).toBe(expected);
  });

  it.each([
    ["allowlist", "allowlist", "off"],
    ["ask", "allowlist", "on-miss"],
    ["full", "full", "off"],
  ] as const)("maps mode %s to effective policy", (mode, security, ask) => {
    expect(execApprovals.resolveExecPolicyForMode(mode)).toEqual({
      security,
      ask,
      autoReview: false,
    });
  });

  it("preserves legacy security and ask when no explicit mode is set", () => {
    expect(execApprovals.resolveExecModePolicy({ security: "full", ask: "always" })).toEqual({
      mode: "ask",
      security: "full",
      ask: "always",
      autoReview: false,
    });
  });

  it("treats unavailable request decisions as optional approvals only", () => {
    expect(
      execApprovals.normalizeExecApprovalUnavailableDecisions([
        "allow-once",
        "deny",
        "allow-always",
        "bad",
      ]),
    ).toEqual(["allow-always"]);
    for (const [ask, unavailableDecisions] of [
      ["on-miss", ["allow-always"]],
      ["on-miss", ["allow-once", "deny", "allow-always", "bad"]],
      ["always", ["allow-always"]],
    ] as const) {
      expect(
        execApprovals.resolveExecApprovalRequestAllowedDecisions({ ask, unavailableDecisions }),
      ).toEqual(["allow-once", "deny"]);
    }
  });

  it("derives unavailable optional decisions from effective approval policy", () => {
    expect(execApprovals.resolveExecApprovalUnavailableDecisions({ ask: "on-miss" })).toEqual([]);
    expect(execApprovals.resolveExecApprovalUnavailableDecisions({ ask: "always" })).toEqual([
      "allow-always",
    ]);
    expect(
      execApprovals.resolveExecApprovalUnavailableDecisions({
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
    expect(execApprovals.requiresExecApproval(testCase)).toBe(testCase.expected);
  });

  it("treats exact-command allow-always approvals as durable trust", () => {
    expect(
      execApprovals.hasDurableExecApproval({
        analysisOk: false,
        segmentAllowlistEntries: [],
        allowlist: [{ pattern: "=command:613b5a60181648fd", source: "allow-always" }],
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
    const result = execApprovals.evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          {
            raw: "/usr/bin/echo ok",
            argv: ["/usr/bin/echo", "ok"],
            resolution: makeMockCommandResolution({ execution: executable }),
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
    expect(result.segmentAllowlistEntries[0]).toMatchObject({ pattern: "/usr/bin/echo" });
    expect(result.segmentAllowlistEntries[1]).toBeNull();
    expect(
      execApprovals.hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
        allowlist,
      }),
    ).toBe(false);
  });

  const host = "~/.openclaw/state/openclaw.sqlite#exec_approvals_config";
  const requested = (value: string, source: string, effectiveValue = value) => ({
    requested: value,
    requestedSource: source,
    effective: effectiveValue,
  });

  it.each<[string, Parameters<typeof snapshot>[0], Record<string, unknown>]>([
    [
      "normalized mode",
      { scopeExecConfig: { mode: "auto" } },
      {
        mode: { ...requested("auto", "tools.exec.mode"), note: "requested mode applies" },
        security: requested("allowlist", "tools.exec.mode"),
        ask: requested("on-miss", "tools.exec.mode"),
      },
    ],
    [
      "narrower legacy override",
      {
        globalExecConfig: { mode: "deny" },
        scopeExecConfig: { security: "full", ask: "off" },
        agentId: "runner",
      },
      {
        mode: requested(
          "full",
          "derived from agents.entries.runner.tools.exec.security and agents.entries.runner.tools.exec.ask",
        ),
        security: requested("full", "agents.entries.runner.tools.exec.security"),
      },
    ],
    [
      "stricter requested ask",
      {
        approvals: { version: 1, defaults: { ask: "off" } },
        scopeExecConfig: { ask: "always" },
      },
      {
        ask: {
          requested: "always",
          host: "off",
          effective: "always",
          note: "requested ask applies",
        },
      },
    ],
    [
      "fallback clamped to security",
      {
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "always", askFallback: "full" },
        },
        scopeExecConfig: { security: "allowlist", ask: "always" },
      },
      { askFallback: { effective: "allowlist", source: host + " defaults.askFallback" } },
    ],
    [
      "malformed host field source",
      {
        approvals: {
          version: 1,
          defaults: { ask: "always" },
          agents: { runner: { ask: "foo" } },
        } as unknown as ExecApprovalsFile,
        globalExecConfig: { ask: "off" },
        agentId: "runner",
      },
      {
        ask: {
          requested: "off",
          host: "always",
          hostSource: host + " defaults.ask",
          effective: "always",
          note: "more aggressive ask wins",
        },
      },
    ],
    [
      "wildcard before defaults",
      {
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: { "*": { security: "allowlist", ask: "always", askFallback: "deny" } },
        },
        scopeExecConfig: { security: "full", ask: "off" },
        agentId: "runner",
      },
      {
        security: { host: "allowlist", hostSource: host + " agents.*.security" },
        ask: { host: "always", hostSource: host + " agents.*.ask" },
        askFallback: { effective: "deny", source: host + " agents.*.askFallback" },
      },
    ],
    [
      "reported defaults",
      {
        approvals: { version: 1, agents: {} },
        scopeExecConfig: { security: "full", ask: "off" },
        hostDefaults: { security: "deny", ask: "on-miss", askFallback: "deny" },
        hostDefaultSource: "node-reported resolved defaults",
      },
      {
        security: {
          requested: "full",
          host: "deny",
          hostSource: "node-reported resolved defaults",
          effective: "deny",
        },
        ask: {
          requested: "off",
          host: "on-miss",
          hostSource: "node-reported resolved defaults",
          effective: "on-miss",
        },
        askFallback: { source: "node-reported resolved defaults" },
      },
    ],
  ])("snapshots %s", (_name, params, expected) => {
    const result = snapshot(params);
    expect(result).toMatchObject(expected);
    if (_name === "fallback clamped to security" || _name === "wildcard before defaults") {
      expect(result.askFallback).toEqual(expected.askFallback);
    }
  });

  it("uses OPENCLAW_STATE_DIR when reporting default host sources", () => {
    const stateDir = path.join(process.cwd(), ".tmp-openclaw-state");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const summary = snapshot({
        approvals: { version: 1, defaults: { security: "allowlist" } },
        scopeExecConfig: { security: "full" },
      });
      expect(summary.security.hostSource).toBe(
        path.join(stateDir, "state", "openclaw.sqlite#exec_approvals_config") +
          " defaults.security",
      );
    });
  });

  it("collects global, configured-agent, and approvals-only agent scopes", () => {
    const snapshots = collectScopes(
      { runner: {} },
      {
        version: 1,
        agents: {
          runner: { security: "allowlist" },
          batch: { ask: "always" },
        },
      },
    );

    expect(snapshots.map((scope) => scope.scopeLabel)).toEqual(["tools.exec", "agent:batch"]);
    expect(snapshots[1]?.ask).toMatchObject({
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
    expect(snapshots[0]?.security).toMatchObject({
      requested: "full",
      requestedSource: "tools.exec.security",
      host: "allowlist",
      effective: "allowlist",
    });
  });

  it("keeps the default agent scope when main has an explicit exec override", () => {
    const snapshots = collectScopes({ [DEFAULT_AGENT_ID]: { tools: { exec: { ask: "always" } } } });

    expect(snapshots.map((scope) => scope.scopeLabel)).toEqual(["tools.exec", "agent:main"]);
    expect(snapshots[1]?.ask).toMatchObject({
      requested: "always",
      requestedSource: "agents.entries.main.tools.exec.ask",
    });
  });
});
