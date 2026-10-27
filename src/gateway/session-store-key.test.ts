import { expect, onTestFinished, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  canonicalizeSessionKeyForAgent,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";

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
