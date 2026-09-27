// Session writes must use the same agent/main aliases as Gateway reads (#29683).
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionKey } from "../config/sessions/session-key.js";
import { resolveCronAgentSessionKey } from "../cron/isolated-agent/session-key.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { normalizeMainKey } from "../routing/session-key.js";

function makeNonDefaultAgentCfg(): OpenClawConfig {
  return {
    session: { mainKey: "work", scope: "per-sender" },
    agents: { list: [{ id: "ops", default: true }] },
  } as OpenClawConfig;
}

function resolveWriteKey(cfg: OpenClawConfig, agentId = "ops", from = "+1234567890") {
  return canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: resolveSessionKey(
      "per-sender",
      { From: from },
      normalizeMainKey(cfg.session?.mainKey),
      agentId,
    ),
  });
}

describe("session key write/read round-trip (#29683)", () => {
  it("write path key matches resolveSessionStoreKey read-back", () => {
    const cfg = makeNonDefaultAgentCfg();
    const writeKey = resolveWriteKey(cfg);
    expect(writeKey).toBe(resolveSessionStoreKey({ cfg, sessionKey: writeKey }));
  });

  it("write path key matches gateway canonical main session key", () => {
    const cfg = makeNonDefaultAgentCfg();
    expect(resolveWriteKey(cfg)).toBe(resolveMainSessionKey(cfg));
  });

  it("cron session key matches gateway canonical main session key", () => {
    const cfg = makeNonDefaultAgentCfg();
    const writeKey = resolveCronAgentSessionKey({
      sessionKey: "main",
      agentId: "ops",
      mainKey: "work",
      cfg,
    });
    expect(writeKey).toBe(resolveMainSessionKey(cfg));
    expect(writeKey).toBe("agent:ops:work");
  });

  it("group keys bypass main-alias canonicalization", () => {
    const cfg = makeNonDefaultAgentCfg();
    const writeKey = resolveWriteKey(cfg, "ops", "group:discord:group:123456789");
    expect(writeKey).toBe(resolveSessionStoreKey({ cfg, sessionKey: writeKey }));
  });

  it("write and gateway canonical keys match when agent is main", () => {
    const cfg = {
      agents: { entries: { main: { default: true } } },
      session: { scope: "per-sender" },
    } as OpenClawConfig;
    const writeKey = resolveWriteKey(cfg, "main");
    expect(writeKey).toBe(resolveMainSessionKey(cfg));
    expect(writeKey).toBe("agent:main:main");
  });
});
