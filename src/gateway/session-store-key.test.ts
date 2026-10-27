import { expect, onTestFinished, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  canonicalizeSessionKeyForAgent,
  resolveSessionStoreIdentity,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";

test("derives interleaved session identities once per immutable config and request", () => {
  const first = freezeJsonSnapshot({ session: { mainKey: "work" } });
  const second = freezeJsonSnapshot({ session: { mainKey: "other" } });
  const key = "agent:ops:main";
  const spy = vi.spyOn(String.prototype, "toLowerCase");
  onTestFinished(() => spy.mockRestore());
  for (const cfg of [first, second]) {
    expect(resolveSessionStoreIdentity({ cfg, sessionKey: key, agentId: "ops" })).toEqual({
      agentId: "ops",
      canonicalKey: `agent:ops:${cfg.session.mainKey}`,
    });
  }
  const initialWork = spy.mock.contexts.filter((value) => value === key).length;
  expect(initialWork).toBeGreaterThan(0);
  for (const cfg of [second, first]) {
    expect(resolveSessionStoreIdentity({ cfg, sessionKey: key, agentId: "ops" })).toEqual({
      agentId: "ops",
      canonicalKey: `agent:ops:${cfg.session.mainKey}`,
    });
  }
  expect(spy.mock.contexts.filter((value) => value === key)).toHaveLength(initialWork);
  expect(
    resolveSessionStoreIdentity({
      cfg: first,
      sessionKey: key,
      agentId: "ops",
      preserveQualifiedAddress: true,
    }),
  ).toEqual({ agentId: "ops", canonicalKey: key });
  expect(() =>
    resolveSessionStoreIdentity({ cfg: first, sessionKey: key, agentId: "other" }),
  ).toThrow();
});

test("refreshes routing after publication, roster retirement, and mutable config edits", () => {
  const previous = getRuntimeConfigSnapshot();
  onTestFinished(() =>
    previous ? setRuntimeConfigSnapshot(previous) : clearRuntimeConfigSnapshot(),
  );
  const cfg: OpenClawConfig = {
    session: { mainKey: "work", store: "/synthetic/shared.sqlite" },
    agents: { defaults: { sessionStore: { agentId: "ops" } }, entries: { ops: {}, other: {} } },
  };
  const read = () => resolveSessionStoreIdentity({ cfg, sessionKey: "main" });
  setRuntimeConfigSnapshot(cfg);
  expect(read()).toEqual({ agentId: "ops", canonicalKey: "agent:ops:work" });
  cfg.session!.mainKey = "next";
  cfg.agents!.defaults!.sessionStore!.agentId = "other";
  setRuntimeConfigSnapshot(cfg);
  expect(read()).toEqual({ agentId: "other", canonicalKey: "agent:other:next" });
  delete cfg.agents!.entries!.other;
  setRuntimeConfigSnapshot(cfg);
  expect(read).toThrow(/no longer configured/);
  clearRuntimeConfigSnapshot();
  cfg.agents!.defaults!.sessionStore!.agentId = "ops";
  expect(read()).toEqual({ agentId: "ops", canonicalKey: "agent:ops:next" });
  cfg.session!.mainKey = "mutable";
  expect(read()).toEqual({ agentId: "ops", canonicalKey: "agent:ops:mutable" });
});

test("keeps fixed-store rejection when a new config collapses a qualified alias to global", () => {
  const cfg: OpenClawConfig = {
    session: { store: "/synthetic/shared.sqlite" },
    agents: { defaults: { sessionStore: { agentId: "ops" } }, entries: { ops: {}, other: {} } },
  };
  const scoped = freezeJsonSnapshot(cfg);
  const global = freezeJsonSnapshot({
    ...cfg,
    session: { ...cfg.session, scope: "global" as const },
  });
  const target = { sessionKey: "agent:other:main", agentId: "other" };
  expect(resolveSessionStoreIdentity({ cfg: scoped, ...target })).toEqual({
    agentId: "other",
    canonicalKey: target.sessionKey,
  });
  expect(() => resolveSessionStoreIdentity({ cfg: global, ...target })).toThrow(/belongs to "ops"/);
  expect(
    resolveSessionStoreIdentity({ cfg: global, ...target, preserveQualifiedAddress: true }),
  ).toEqual({ agentId: "other", canonicalKey: target.sessionKey });
});

test("normalizes qualified store keys only once", () => {
  const key = "agent:ops:subagent:placement-normalization-work-count";
  const spy = vi.spyOn(String.prototype, "toLowerCase");
  onTestFinished(() => spy.mockRestore());
  expect(resolveSessionStoreKey({ cfg: {}, sessionKey: key, storeAgentId: "ops" })).toBe(key);
  expect(spy.mock.contexts.filter((value) => value === key)).toHaveLength(1);
});

test.each([
  [" AGENT:OPS:SUBAGENT:Run-1 ", "agent:ops:subagent:run-1"],
  ["agent: OPS :dashboard:Work", "agent: ops :dashboard:work"],
  ["AGENT:OPS:MATRIX:CHANNEL:!AbC:Example.org", "agent:ops:matrix:channel:!AbC:Example.org"],
  ["AGENT:OPS:SIGNAL:GROUP:AbC=", "agent:ops:signal:group:AbC="],
  ["AGENT:OPS:", "agent:ops:"],
  ["AGENT:OPS::TAIL", "agent:ops::tail"],
])("preserves store-key normalization for %s", (sessionKey, expected) => {
  expect(resolveSessionStoreKey({ cfg: {}, sessionKey, storeAgentId: "ops" })).toBe(expected);
  expect(resolveStoredSessionKeyForAgentStore({ cfg: {}, sessionKey, agentId: "ops" })).toBe(
    expected,
  );
});

test("keeps legacy aliases config-dependent and fixed-store unqualified keys intact", () => {
  const cfg: OpenClawConfig = {
    session: { mainKey: "work", store: "/synthetic/shared.sqlite" },
    agents: { defaults: { sessionStore: { agentId: "ops" } }, entries: { ops: {} } },
  };
  const globalCfg: OpenClawConfig = { ...cfg, session: { ...cfg.session, scope: "global" } };
  for (const current of [cfg, globalCfg, cfg]) {
    expect(resolveSessionStoreKey({ cfg: current, sessionKey: "AGENT:MAIN:MAIN" })).toBe(
      current === globalCfg ? "global" : "agent:ops:work",
    );
    expect(
      resolveStoredSessionKeyForAgentStore({
        cfg: current,
        sessionKey: " MixedCase-legacy-key ",
        agentId: "ops",
      }),
    ).toBe("MixedCase-legacy-key");
  }
});

test("canonicalizes a session key once without folding opaque peer IDs", () => {
  const key = "AGENT:OPS:SUBAGENT:normalization-work-count";
  const spy = vi.spyOn(String.prototype, "toLowerCase");
  onTestFinished(() => spy.mockRestore());
  expect(canonicalizeSessionKeyForAgent("ignored", key)).toBe(
    "agent:ops:subagent:normalization-work-count",
  );
  expect(spy.mock.contexts.filter((value) => value === key)).toHaveLength(1);
  for (const [raw, expected] of [
    [" GLOBAL ", "global"],
    [" UnKnown ", "unknown"],
    [" Thread-1 ", "agent:ops:thread-1"],
    ["MATRIX:CHANNEL:!AbC:Example.org", "agent:ops:matrix:channel:!AbC:Example.org"],
    ["SIGNAL:GROUP:AbC=", "agent:ops:signal:group:AbC="],
  ] as const) {
    expect(canonicalizeSessionKeyForAgent("OPS", raw)).toBe(expected);
  }
});
