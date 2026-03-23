import { describe, expect, it } from "vitest";
import { buildGatewayStatusWarnings, pickPrimaryProbedTarget } from "./output.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

function makeProbedTarget(
  overrides: Partial<GatewayStatusProbedTarget> & {
    kind: GatewayStatusProbedTarget["target"]["kind"];
    probeOk?: boolean;
    probeError?: string | null;
    connectLatencyMs?: number | null;
  },
): GatewayStatusProbedTarget {
  const probeOk = overrides.probeOk ?? true;
  return {
    target: {
      id: overrides.kind,
      kind: overrides.kind,
      url: `ws://127.0.0.1:18789`,
      active: true,
      ...overrides.target,
    },
    probe: {
      url: "ws://127.0.0.1:18789",
      ok: probeOk,
      connectLatencyMs: overrides.connectLatencyMs ?? (probeOk ? 32 : null),
      error: overrides.probeError ?? null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      ...overrides.probe,
    },
    configSummary: null,
    self: null,
    authDiagnostics: overrides.authDiagnostics ?? [],
    ...overrides,
  } as GatewayStatusProbedTarget;
}

describe("pickPrimaryProbedTarget", () => {
  it("returns null for empty list", () => {
    expect(pickPrimaryProbedTarget([])).toBeNull();
  });

  it("returns null when no target is reachable", () => {
    const result = pickPrimaryProbedTarget([
      makeProbedTarget({ kind: "localLoopback", probeOk: false }),
    ]);
    expect(result).toBeNull();
  });

  it("prefers explicit over other kinds", () => {
    const result = pickPrimaryProbedTarget([
      makeProbedTarget({ kind: "localLoopback" }),
      makeProbedTarget({ kind: "explicit" }),
    ]);
    expect(result?.target.kind).toBe("explicit");
  });

  it("prefers sshTunnel when no explicit exists", () => {
    const result = pickPrimaryProbedTarget([
      makeProbedTarget({ kind: "localLoopback" }),
      makeProbedTarget({ kind: "sshTunnel" }),
    ]);
    expect(result?.target.kind).toBe("sshTunnel");
  });

  it("prefers configRemote over localLoopback", () => {
    const result = pickPrimaryProbedTarget([
      makeProbedTarget({ kind: "localLoopback" }),
      makeProbedTarget({ kind: "configRemote" }),
    ]);
    expect(result?.target.kind).toBe("configRemote");
  });

  it("returns localLoopback as last resort", () => {
    const result = pickPrimaryProbedTarget([makeProbedTarget({ kind: "localLoopback" })]);
    expect(result?.target.kind).toBe("localLoopback");
  });

  it("treats scope-limited probes as reachable", () => {
    const result = pickPrimaryProbedTarget([
      makeProbedTarget({
        kind: "localLoopback",
        probeOk: false,
        probeError: "missing scope: operator.read",
        connectLatencyMs: 32,
      }),
    ]);
    expect(result?.target.kind).toBe("localLoopback");
  });
});

describe("buildGatewayStatusWarnings", () => {
  it("returns empty array when everything is healthy", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [makeProbedTarget({ kind: "localLoopback" })],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    expect(warnings).toEqual([]);
  });

  it("warns about SSH tunnel failure", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [],
      sshTarget: "alice@gw.example.com",
      sshTunnelStarted: false,
      sshTunnelError: "Connection refused",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("ssh_tunnel_failed");
    expect(warnings[0].message).toContain("Connection refused");
  });

  it("warns about SSH tunnel failure without error detail", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [],
      sshTarget: "alice@gw.example.com",
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("falling back to direct probes");
  });

  it("does not warn about SSH when tunnel started successfully", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [makeProbedTarget({ kind: "sshTunnel" })],
      sshTarget: "alice@gw.example.com",
      sshTunnelStarted: true,
      sshTunnelError: null,
    });
    expect(warnings.find((w) => w.code === "ssh_tunnel_failed")).toBeUndefined();
  });

  it("warns when multiple gateways are reachable", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        makeProbedTarget({ kind: "localLoopback" }),
        makeProbedTarget({ kind: "configRemote" }),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    const multiWarning = warnings.find((w) => w.code === "multiple_gateways");
    expect(multiWarning).toBeDefined();
    expect(multiWarning?.targetIds).toHaveLength(2);
  });

  it("warns about unresolved auth diagnostics on unreachable targets", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        makeProbedTarget({
          kind: "configRemote",
          probeOk: false,
          authDiagnostics: ["Token resolved to empty string"],
        }),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    const authWarning = warnings.find((w) => w.code === "auth_secretref_unresolved");
    expect(authWarning).toBeDefined();
    expect(authWarning?.message).toBe("Token resolved to empty string");
  });

  it("skips auth diagnostics on reachable targets", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        makeProbedTarget({
          kind: "localLoopback",
          probeOk: true,
          authDiagnostics: ["Token resolved to empty string"],
        }),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    expect(warnings.find((w) => w.code === "auth_secretref_unresolved")).toBeUndefined();
  });

  it("warns about scope-limited probes", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        makeProbedTarget({
          kind: "localLoopback",
          probeOk: false,
          probeError: "missing scope: operator.read",
          connectLatencyMs: 32,
        }),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
    });
    const scopeWarning = warnings.find((w) => w.code === "probe_scope_limited");
    expect(scopeWarning).toBeDefined();
    expect(scopeWarning?.message).toContain("operator.read");
  });
});
