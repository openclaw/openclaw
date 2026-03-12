import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

function minimalCfg(): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: { defaults: { model: "openai/gpt-4o-mini" } },
  } as unknown as OpenClawConfig;
}

describe("applySessionsPatchToStore - spawnedBy validation", () => {
  it("accepts spawnedBy for agent-scoped subagent sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const storeKey = "agent:coding-acp:subagent:123e4567-e89b-12d3-a456-426614174000";

    const res = await applySessionsPatchToStore({
      cfg: minimalCfg(),
      store,
      storeKey,
      patch: { key: storeKey, spawnedBy: "agent:main:discord:channel:ops" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.spawnedBy).toBe("agent:main:discord:channel:ops");
    }
  });

  it("accepts spawnedBy for agent-scoped acp sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const storeKey = "agent:coding-acp:acp:tool:abcdef";

    const res = await applySessionsPatchToStore({
      cfg: minimalCfg(),
      store,
      storeKey,
      patch: { key: storeKey, spawnedBy: "agent:main:discord:channel:ops" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.spawnedBy).toBe("agent:main:discord:channel:ops");
    }
  });

  it("rejects spawnedBy for normal chat sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const storeKey = "agent:main:discord:channel:ops";

    const res = await applySessionsPatchToStore({
      cfg: minimalCfg(),
      store,
      storeKey,
      patch: { key: storeKey, spawnedBy: "agent:main:discord:channel:ops" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("spawnedBy is only supported");
    }
  });
});
