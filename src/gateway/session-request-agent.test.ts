import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionEventAgentScope as eventScope,
  resolveRequestedSessionAgentId as resolve,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "./session-request-agent.js";

function fixedStoreConfig(owner: string): OpenClawConfig {
  return {
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: owner } },
      entries: { ops: {}, research: {} },
    },
  };
}

function explicitConfig(): OpenClawConfig {
  return { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } };
}

describe("requested session agent ownership", () => {
  it("uses the configured persisted owner for a bare key", () => {
    const cfg = fixedStoreConfig("ops");
    expect(tryResolveSessionCompatibilityOwnerAgentId(cfg, "global")).toBe("ops");
    expect(resolve(cfg, "global")).toEqual({ ok: true, agentId: "ops" });
  });

  it.each(["main", "primary"])(
    "validates fixed ownership after the explicit %s alias becomes global",
    (alias) => {
      const key = `agent:research:${alias}`;
      const cfg = fixedStoreConfig("ops");
      const owned = { ok: true, agentId: "research" };
      cfg.session = { ...cfg.session, scope: "global", mainKey: "primary" };
      for (const owner of ["ops", "retired"]) {
        cfg.agents!.defaults!.sessionStore!.agentId = owner;
        expect.soft(resolve(cfg, key, "research")).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(resolve(cfg, key)).toEqual(owned);
      cfg.agents!.defaults!.sessionStore!.agentId = "research";
      expect(resolve(cfg, key, "research")).toEqual(owned);
      cfg.session.store = "/synthetic/{agentId}/sessions.sqlite";
      cfg.agents!.defaults!.sessionStore!.agentId = "ops";
      expect(resolve(cfg, key, "research")).toEqual(owned);
    },
  );

  it("returns typed ownership results for arbitrary bare keys before canonicalization", () => {
    const cfg = explicitConfig();

    expect(resolve(cfg, "thread-1")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
    expect(resolve(cfg, "thread-1", "research")).toEqual({
      ok: true,
      agentId: "research",
    });
  });

  it.each(["", "агент✨"])(
    "rejects explicit unrepresentable agent id %j instead of selecting main",
    (agentId) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      };

      expect(resolve(cfg, "global", agentId)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Unknown agent id "${agentId}"`,
        },
      });
    },
  );

  it("keeps retired agent-qualified history readable outside global scope", () => {
    const cfg = explicitConfig();

    expect(resolve(cfg, "agent:retired:main")).toEqual({
      ok: true,
      agentId: "retired",
    });
    expect(resolve({ ...cfg, session: { scope: "global" } }, "agent:retired:main")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });
});

describe("session event agent scope", () => {
  it("separates configured, retired, legacy, and explicit event ownership", () => {
    const configured = fixedStoreConfig("ops");
    const retired = fixedStoreConfig("retired");
    const legacy = { agents: { entries: { main: {} } } };
    expect(eventScope(configured, "global")).toEqual([undefined, "ops", "ops"]);
    expect(eventScope(retired, "global")).toEqual([undefined, "retired", undefined]);
    expect(eventScope(legacy, "global")).toEqual([undefined, "main", "main"]);
    expect(eventScope(configured, "global", "research")).toEqual(["research", "research", "ops"]);
  });

  it("rejects conflicting qualified event identity without consulting fallbacks", () => {
    const cfg = fixedStoreConfig("ops");
    const key = "agent:research:main";
    expect(eventScope(cfg, key, "ops")).toBeNull();
    expect(eventScope(cfg, key)).toEqual([undefined, "research", undefined]);
    expect(eventScope(cfg, key, undefined, true)).toEqual(["research", "research", undefined]);
    expect(eventScope(cfg, "agent:retired:main", undefined, true)).toEqual([
      undefined,
      "retired",
      undefined,
    ]);
  });
});
