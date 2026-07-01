import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

const parentSession: SessionEntry = {
  providerOverride: "anthropic",
  modelOverride: "claude-opus-4-7",
} as unknown as SessionEntry;

describe("resolveStoredModelOverride", () => {
  it("loads parent overrides without requiring a whole session store", () => {
    const loadSessionEntry = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("returns the child entry's own override before considering the parent", () => {
    const child: SessionEntry = {
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    } as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: { "main:abc": parentSession },
      sessionKey: "main:abc:topic:t1",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      source: "session",
    });
  });

  it("inherits the parent override for non-subagent child sessions", () => {
    const child: SessionEntry = {} as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: { "main:abc": parentSession },
      sessionKey: "main:abc:topic:t1",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      source: "parent",
    });
  });

  it("does not inherit a parent /model override for spawned subagent sessions", () => {
    const child: SessionEntry = {
      subagentRole: "orchestrator",
      spawnDepth: 1,
    } as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: { "main:abc": parentSession },
      sessionKey: "main:abc:sub:1",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toBeNull();
  });

  it("does not inherit a parent /model override when only spawnDepth >= 1 is set", () => {
    const child: SessionEntry = { spawnDepth: 1 } as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: { "main:abc": parentSession },
      sessionKey: "main:abc:sub:1",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toBeNull();
  });

  it("still returns the subagent child's own direct override", () => {
    const child: SessionEntry = {
      subagentRole: "leaf",
      spawnDepth: 2,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    } as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: { "main:abc": parentSession },
      sessionKey: "main:abc:sub:2",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      source: "session",
    });
  });

  it("returns null for a subagent child with no override even if no parent entry exists", () => {
    const child: SessionEntry = {
      subagentRole: "orchestrator",
      spawnDepth: 1,
    } as unknown as SessionEntry;
    const out = resolveStoredModelOverride({
      sessionEntry: child,
      sessionStore: {},
      sessionKey: "main:abc:sub:1",
      parentSessionKey: "main:abc",
      defaultProvider: "anthropic",
    });
    expect(out).toBeNull();
  });
});
