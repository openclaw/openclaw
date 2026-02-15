import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

describe("gateway sessions patch", () => {
  test("persists thinkingLevel=off (does not clear)", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { thinkingLevel: "off" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { thinkingLevel: "low" } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { thinkingLevel: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.thinkingLevel).toBeUndefined();
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "off" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "on" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { elevatedLevel: "off" } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "maybe" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-5",
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: async () => [{ provider: "openai", id: "gpt-5.2" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.providerOverride).toBe("openai");
    expect(res.entry.modelOverride).toBe("gpt-5.2");
    expect(res.entry.authProfileOverride).toBeUndefined();
    expect(res.entry.authProfileOverrideSource).toBeUndefined();
    expect(res.entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:child",
      patch: { spawnDepth: 2 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.spawnDepth).toBe(2);
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { spawnDepth: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("spawnDepth is only supported");
  });
});
