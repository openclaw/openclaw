/**
 * Session key write/read round-trip tests.
 *
 * Validates that active write paths carry the real agent id into session-key
 * resolution. Legacy cross-agent key repair belongs to doctor migration, not
 * runtime alias bridging.
 */
import { describe, expect, it } from "vitest";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import { resolveSessionRowKey } from "../../gateway/session-row-key.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../config.js";
import { canonicalizeMainSessionAlias, resolveMainSessionKey } from "./main-session.js";
import { resolveSessionKey } from "./session-key.js";

function makeNonDefaultAgentCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    session: { mainKey: "work", scope: "per-sender" },
    agents: { list: [{ id: "ops", default: true }] },
    ...overrides,
  } as OpenClawConfig;
}

describe("session key write/read round-trip (#29683)", () => {
  describe("initSessionState write path consistency", () => {
    it("write path key matches resolveSessionRowKey read-back", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      // Write path: resolveSessionKey receives the resolved agent id.
      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "+1234567890" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      // Re-read path: resolveSessionRowKey (used by loadSessionEntry)
      const readKey = resolveSessionRowKey({ cfg, sessionKey: writeKey });

      // The write key and read-back key must match
      expect(writeKey).toBe(readKey);
    });

    it("write path key matches gateway canonical main session key", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "+1234567890" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      // Gateway canonical key: resolveMainSessionKey uses configured agent
      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      expect(writeKey).toBe(gatewayCanonicalKey);
    });

    it("does not bridge legacy agent:main aliases at runtime", () => {
      const cfg = makeNonDefaultAgentCfg();

      expect(
        canonicalizeMainSessionAlias({
          cfg,
          agentId: "ops",
          sessionKey: "agent:main:work",
        }),
      ).toBe("agent:main:work");
    });
  });

  describe("cron write path round-trip", () => {
    it("cron session key matches gateway canonical main session key", () => {
      const cfg = makeNonDefaultAgentCfg();

      const writeKey = resolveCronAgentSessionKey({
        sessionKey: "main",
        agentId: "ops",
        mainKey: "work",
        cfg,
      });

      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      expect(writeKey).toBe(gatewayCanonicalKey);
      expect(writeKey).toBe("agent:ops:work");
    });
  });

  describe("group session keys are unaffected", () => {
    it("group keys bypass main-alias canonicalization", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "group:discord:group:123456789" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      const readKey = resolveSessionRowKey({ cfg, sessionKey: writeKey });

      // Group keys contain channel-scoped identifiers and are not main aliases,
      // so they round-trip correctly regardless of agent config.
      expect(writeKey).toBe(readKey);
    });
  });

  describe("no-op when default agent is main", () => {
    it("write and gateway canonical keys match when agent is main", () => {
      const cfg = { session: { scope: "per-sender" } } as OpenClawConfig;
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey("per-sender", { From: "+1234567890" }, mainKey);
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId: "main",
        sessionKey: rawWriteKey,
      });

      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      expect(writeKey).toBe(gatewayCanonicalKey);
      expect(writeKey).toBe("agent:main:main");
    });
  });
});
