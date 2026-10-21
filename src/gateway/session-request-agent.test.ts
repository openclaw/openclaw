import { expect, it } from "vitest";
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

const configured = fixedStoreConfig("ops");
const qualifiedKey = "agent:research:main";
it.each([
  [configured, "global", undefined, false, [undefined, "ops", "ops"]],
  [fixedStoreConfig("retired"), "global", undefined, false, [undefined, "retired", undefined]],
  [{ agents: { entries: { main: {} } } }, "global", undefined, false, [undefined, "main", "main"]],
  [configured, "global", "research", false, ["research", "research", "ops"]],
  [configured, qualifiedKey, "ops", false, null],
  [configured, qualifiedKey, undefined, false, [undefined, "research", undefined]],
  [configured, qualifiedKey, undefined, true, ["research", "research", undefined]],
  [configured, "agent:retired:main", undefined, true, [undefined, "retired", undefined]],
] as const)("resolves event identity %#", (cfg, key, explicit, qualified, expected) => {
  expect(eventScope(cfg, key, explicit, qualified)).toEqual(expected);
});
