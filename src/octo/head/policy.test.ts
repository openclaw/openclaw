// Octopus Orchestrator -- PolicyService tests (M5-01)

import { describe, expect, it } from "vitest";
import type { OctoPolicyConfig } from "../config/schema.ts";
import { OctoLogger, noopLoggerProvider } from "./logging.ts";
import { PolicyService, type PolicyDecision, type PolicyProfile } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<OctoPolicyConfig>): OctoPolicyConfig {
  return {
    enforcementActive: true,
    defaultProfileRef: null,
    ...overrides,
  };
}

function makeLogger(): OctoLogger {
  return new OctoLogger("policy-test", noopLoggerProvider);
}

const restrictedProfile: PolicyProfile = {
  name: "restricted",
  allowedTools: ["read", "write", "search"],
  deniedTools: ["rm-rf", "format-disk"],
  maxCostUsd: 10,
  sandboxLevel: "strict",
};

const openProfile: PolicyProfile = {
  name: "open",
  allowedTools: [],
  deniedTools: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PolicyService", () => {
  // -- check: deny dangerous tool -----------------------------------------
  it("denies an action that is on the denied list", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result = svc.check("rm-rf", restrictedProfile);
    expect(result.decision).toBe("deny");
    expect((result as { ruleId: string }).ruleId).toBe("denied-tool");
  });

  // -- check: allow within profile ----------------------------------------
  it("allows an action within the allowed list", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result = svc.check("read", restrictedProfile);
    expect(result).toStrictEqual({ decision: "allow" });
  });

  // -- check: deny action not in allow-list -------------------------------
  it("denies an action not in the allow-list when allow-list is non-empty", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result = svc.check("deploy", restrictedProfile);
    expect(result.decision).toBe("deny");
    expect((result as { ruleId: string }).ruleId).toBe("not-allowed-tool");
  });

  // -- check: escalation on cost exceeded ---------------------------------
  it("escalates when cost exceeds profile ceiling", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result = svc.check("read", restrictedProfile, { costUsd: 50 });
    expect(result.decision).toBe("escalate");
    expect((result as { reason: string }).reason).toContain("exceeds ceiling");
  });

  // -- check: enforcement off -> always allow -----------------------------
  it("returns allow when enforcement is off even for denied tools", () => {
    const cfg = makeConfig({ enforcementActive: false });
    const svc = new PolicyService(cfg, new Map(), makeLogger());
    const result = svc.check("rm-rf", restrictedProfile);
    expect(result).toStrictEqual({ decision: "allow" });
  });

  // -- check: enforcement off -> always allow (cost) ----------------------
  it("returns allow when enforcement is off even when cost exceeds ceiling", () => {
    const cfg = makeConfig({ enforcementActive: false });
    const svc = new PolicyService(cfg, new Map(), makeLogger());
    const result = svc.check("read", restrictedProfile, { costUsd: 999 });
    expect(result).toStrictEqual({ decision: "allow" });
  });

  // -- resolve: default profile -------------------------------------------
  it("resolves the default profile when defaultProfileRef is set", () => {
    const profiles = new Map<string, PolicyProfile>([
      ["restricted", restrictedProfile],
      ["open", openProfile],
    ]);
    const cfg = makeConfig({ defaultProfileRef: "restricted" });
    const svc = new PolicyService(cfg, profiles, makeLogger());
    const resolved = svc.resolve("subagent", "home", "node-1");
    expect(resolved.name).toBe("restricted");
  });

  // -- resolve: specific profile (first in map when no ref) ---------------
  it("resolves the first profile when defaultProfileRef is null", () => {
    const profiles = new Map<string, PolicyProfile>([
      ["open", openProfile],
      ["restricted", restrictedProfile],
    ]);
    const cfg = makeConfig({ defaultProfileRef: null });
    const svc = new PolicyService(cfg, profiles, makeLogger());
    const resolved = svc.resolve("pty", "worker", "node-2");
    expect(resolved.name).toBe("open");
  });

  // -- resolve: fallback when profiles map is empty -----------------------
  it("resolves a permissive fallback when profiles map is empty", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const resolved = svc.resolve("acp", "home", "node-3");
    expect(resolved.name).toBe("__default__");
    expect(resolved.deniedTools).toStrictEqual([]);
  });

  // -- check: open profile allows everything ------------------------------
  it("allows any action when profile has empty allow and deny lists", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result = svc.check("anything", openProfile);
    expect(result).toStrictEqual({ decision: "allow" });
  });

  // -- check: cost within limit passes ------------------------------------
  it("allows when cost is within the ceiling", () => {
    const svc = new PolicyService(makeConfig(), new Map(), makeLogger());
    const result: PolicyDecision = svc.check("read", restrictedProfile, { costUsd: 5 });
    expect(result).toStrictEqual({ decision: "allow" });
  });
});
