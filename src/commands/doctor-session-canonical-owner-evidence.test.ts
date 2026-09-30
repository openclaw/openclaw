import { describe, expect, it } from "vitest";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";

/**
 * The resolver walks `canonicalOwnerSessionKey` links to fold alias chains. Its
 * `seen` set only guards *cycles*; a deep *acyclic* chain (thousands of distinct
 * session keys) previously recursed once per link with no bound and overflowed
 * the stack. These tests lock in the depth cap.
 */
describe("applyCanonicalOwnerEvidence depth cap", () => {
  it("resolves a deep acyclic alias chain without overflowing the stack", () => {
    const sqlitePath = "/store/openclaw-agent.sqlite";
    const depth = 20_000;
    // Build an acyclic chain: node 0 -> 1 -> ... -> depth-1 -> terminal.
    // Every node's `canonicalOwnerSessionKey` is the *next* node's sessionKey,
    // so each link is a distinct identity (no cycle for `seen` to catch).
    const inventory = Array.from({ length: depth }, (_, i) => ({
      canonicalKey: `key-${i}`,
      canonicalOwnerSessionKey: `session-${i + 1}`,
      sessionKey: `session-${i}`,
      storedKey: `session-${i}`,
      target: { agentId: "main", sqlitePath },
    }));
    // Terminal node: no owner, so it is the root of the chain.
    inventory.push({
      canonicalKey: "root",
      canonicalOwnerSessionKey: undefined,
      sessionKey: `session-${depth}`,
      storedKey: `session-${depth}`,
      target: { agentId: "main", sqlitePath },
    });

    // Without the depth cap this throws RangeError; with it, it terminates and
    // every node folds to its own canonical key at the cut point.
    expect(() => applyCanonicalOwnerEvidence(inventory)).not.toThrow();
  });

  it("still folds short chains to the terminal owner's canonical key", () => {
    const sqlitePath = "/store/openclaw-agent.sqlite";
    const inventory = [
      {
        canonicalKey: "alias",
        canonicalOwnerSessionKey: "owner",
        sessionKey: "alias",
        storedKey: "alias",
        target: { agentId: "main", sqlitePath },
      },
      {
        canonicalKey: "root",
        canonicalOwnerSessionKey: undefined,
        sessionKey: "owner",
        storedKey: "owner",
        target: { agentId: "main", sqlitePath },
      },
    ];
    const result = applyCanonicalOwnerEvidence(inventory);
    // The alias node must fold to the owner's canonical key ("root").
    expect(inventory[0].canonicalKey).toBe("root");
    expect(result).toBeInstanceOf(Map);
  });

  it("breaks cycles without infinite recursion", () => {
    const sqlitePath = "/store/openclaw-agent.sqlite";
    const inventory = [
      {
        canonicalKey: "a",
        canonicalOwnerSessionKey: "b",
        sessionKey: "a",
        storedKey: "a",
        target: { agentId: "main", sqlitePath },
      },
      {
        canonicalKey: "b",
        canonicalOwnerSessionKey: "a",
        sessionKey: "b",
        storedKey: "b",
        target: { agentId: "main", sqlitePath },
      },
    ];
    expect(() => applyCanonicalOwnerEvidence(inventory)).not.toThrow();
  });
});
