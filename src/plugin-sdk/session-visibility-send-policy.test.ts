/**
 * Tests for visibility guard / A2A send-policy separation (Round 15, openclaw#51).
 *
 * Key invariant: for `send` actions, A2A policy should take priority over
 * `tools.sessions.visibility`. A2A-allowed sends must pass even when
 * visibility !== "all". Read-surface actions (history, list, status) must
 * still be gated by visibility.
 */
import { describe, expect, it } from "vitest";
import {
  createSessionVisibilityChecker,
  createAgentToAgentPolicy,
  type AgentToAgentPolicy,
  type SessionToolsVisibility,
} from "./session-visibility.js";

function makeA2APolicy(enabled: boolean, allow?: string[]): AgentToAgentPolicy {
  return createAgentToAgentPolicy({
    tools: {
      agentToAgent: {
        enabled,
        ...(allow ? { allow } : {}),
      },
    },
  } as never);
}

describe("visibility guard / send-policy separation", () => {
  // ── SEND action: A2A policy overrides visibility ──────────────

  describe("send: A2A policy takes priority over visibility", () => {
    it("allows A2A-allowed send when visibility=tree (not all)", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });

    it("allows A2A-allowed send when visibility=self", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "self" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });

    it("allows A2A-allowed send when visibility=agent", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "agent" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });

    it("allows A2A-allowed send when visibility=all", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "all" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });

    it("rejects cross-agent send when A2A is disabled", () => {
      const a2aPolicy = makeA2APolicy(false);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "all" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("disabled"),
      });
    });

    it("rejects cross-agent send when A2A allow list does not match", () => {
      const a2aPolicy = makeA2APolicy(true, ["seoseo"]);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("denied"),
      });
    });

    it("allows same-agent send regardless of visibility", () => {
      const a2aPolicy = makeA2APolicy(false);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "self" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      // Same session → always allowed
      const result = guard.check("agent:main:quietchat:direct:alice");
      expect(result).toEqual({ allowed: true });
    });

    it("allows spawned child send under tree visibility", () => {
      const a2aPolicy = makeA2APolicy(false);
      const guard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(["subagent:child-1"]),
      });

      const result = guard.check("subagent:child-1");
      expect(result).toEqual({ allowed: true });
    });
  });

  // ── READ actions: visibility still gates ───────────────────────

  describe("history: visibility still gates read access", () => {
    it("rejects cross-agent history when visibility=tree", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("visibility is restricted"),
      });
    });

    it("rejects cross-agent history when visibility=self", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "self" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("visibility is restricted"),
      });
    });

    it("allows cross-agent history when visibility=all + A2A enabled", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "all" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });

    it("rejects cross-agent history when visibility=all but A2A disabled", () => {
      const a2aPolicy = makeA2APolicy(false);
      const guard = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "all" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("disabled"),
      });
    });
  });

  describe("list: visibility still gates read access", () => {
    it("rejects cross-agent list when visibility=tree", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "list",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("visibility is restricted"),
      });
    });
  });

  describe("status: visibility still gates read access", () => {
    it("rejects cross-agent status when visibility=tree", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "status",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.stringContaining("visibility is restricted"),
      });
    });

    it("allows cross-agent status when visibility=all + A2A enabled", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);
      const guard = createSessionVisibilityChecker({
        action: "status",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "all" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: null,
      });

      const result = guard.check("agent:other:quietchat:direct:bob");
      expect(result).toEqual({ allowed: true });
    });
  });

  // ── No read-surface expansion ─────────────────────────────────

  describe("no read-surface expansion from send-policy separation", () => {
    it("send bypass does not grant history access", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);

      // Send passes
      const sendGuard = createSessionVisibilityChecker({
        action: "send",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });
      expect(sendGuard.check("agent:other:quietchat:direct:bob")).toEqual({ allowed: true });

      // But history is still blocked
      const historyGuard = createSessionVisibilityChecker({
        action: "history",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });
      expect(historyGuard.check("agent:other:quietchat:direct:bob")).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.any(String),
      });
    });

    it("send bypass does not grant list access", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);

      const listGuard = createSessionVisibilityChecker({
        action: "list",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });
      expect(listGuard.check("agent:other:quietchat:direct:bob")).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.any(String),
      });
    });

    it("send bypass does not grant status access", () => {
      const a2aPolicy = makeA2APolicy(true, ["*"]);

      const statusGuard = createSessionVisibilityChecker({
        action: "status",
        requesterSessionKey: "agent:main:quietchat:direct:alice",
        visibility: "tree" as SessionToolsVisibility,
        a2aPolicy,
        spawnedKeys: new Set(),
      });
      expect(statusGuard.check("agent:other:quietchat:direct:bob")).toEqual({
        allowed: false,
        status: "forbidden",
        error: expect.any(String),
      });
    });
  });
});
