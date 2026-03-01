import { describe, expect, it } from "vitest";
import type { AgentsListResult, SessionsListResult } from "./types.ts";

// Stub browser globals that i18n accesses at module level.
if (typeof globalThis.localStorage === "undefined") {
  const store: Record<string, string> = {};
  // @ts-expect-error — minimal stub for Node tests
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

// Dynamic import after localStorage stub is applied.
const { parseSessionKey, resolveSessionDisplayName, resolveSessionOptions } =
  await import("./app-render.helpers.ts");

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct" as const, updatedAt: 0, ...overrides };
}

function sessions(rows: SessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: rows.length,
    defaults: { model: null, contextTokens: null },
    sessions: rows,
  };
}

function agents(ids: string[], opts?: { mainKey?: string; defaultId?: string }): AgentsListResult {
  return {
    defaultId: opts?.defaultId ?? ids[0] ?? "main",
    mainKey: opts?.mainKey ?? "main",
    scope: "per-sender",
    agents: ids.map((id) => ({ id })),
  };
}

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("identifies main session (bare 'main')", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("identifies main session (agent:main:main)", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  it("identifies subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  it("identifies cron sessions", () => {
    expect(parseSessionKey("agent:main:cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("identifies direct chat with known channel", () => {
    expect(parseSessionKey("agent:main:bluebubbles:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage · +19257864429",
    });
  });

  it("identifies direct chat with telegram", () => {
    expect(parseSessionKey("agent:main:telegram:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Telegram · user123",
    });
  });

  it("identifies group chat with known channel", () => {
    expect(parseSessionKey("agent:main:discord:group:guild-chan")).toEqual({
      prefix: "",
      fallbackName: "Discord Group",
    });
  });

  it("capitalises unknown channels in direct/group patterns", () => {
    expect(parseSessionKey("agent:main:mychannel:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mychannel · user1",
    });
  });

  it("identifies channel-prefixed legacy keys", () => {
    expect(parseSessionKey("bluebubbles:g-agent-main-bluebubbles-direct-+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage Session",
    });
    expect(parseSessionKey("discord:123:456")).toEqual({
      prefix: "",
      fallbackName: "Discord Session",
    });
  });

  it("handles bare channel name as key", () => {
    expect(parseSessionKey("telegram")).toEqual({
      prefix: "",
      fallbackName: "Telegram Session",
    });
  });

  it("returns raw key for unknown patterns", () => {
    expect(parseSessionKey("something-unknown")).toEqual({
      prefix: "",
      fallbackName: "something-unknown",
    });
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  // ── Key-only fallbacks (no row) ──────────────────

  it("returns 'Main Session' for agent:main:main key", () => {
    expect(resolveSessionDisplayName("agent:main:main")).toBe("Main Session");
  });

  it("returns 'Main Session' for bare 'main' key", () => {
    expect(resolveSessionDisplayName("main")).toBe("Main Session");
  });

  it("returns 'Subagent:' for subagent key without row", () => {
    expect(resolveSessionDisplayName("agent:main:subagent:abc-123")).toBe("Subagent:");
  });

  it("returns 'Cron Job:' for cron key without row", () => {
    expect(resolveSessionDisplayName("agent:main:cron:abc-123")).toBe("Cron Job:");
  });

  it("parses direct chat key with channel", () => {
    expect(resolveSessionDisplayName("agent:main:bluebubbles:direct:+19257864429")).toBe(
      "iMessage · +19257864429",
    );
  });

  it("parses channel-prefixed legacy key", () => {
    expect(resolveSessionDisplayName("discord:123:456")).toBe("Discord Session");
  });

  it("returns raw key for unknown patterns", () => {
    expect(resolveSessionDisplayName("something-custom")).toBe("something-custom");
  });

  // ── With row data (label / displayName) ──────────

  it("returns parsed fallback when row has no label or displayName", () => {
    expect(resolveSessionDisplayName("agent:main:main", row({ key: "agent:main:main" }))).toBe(
      "Main Session",
    );
  });

  it("returns parsed fallback when displayName matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", displayName: "mykey" }))).toBe(
      "mykey",
    );
  });

  it("returns parsed fallback when label matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", label: "mykey" }))).toBe("mykey");
  });

  it("uses label alone when available", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", label: "General" }),
      ),
    ).toBe("General");
  });

  it("falls back to displayName when label is absent", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat" }),
      ),
    ).toBe("My Chat");
  });

  it("prefers label over displayName when both are present", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
      ),
    ).toBe("General");
  });

  it("ignores whitespace-only label and falls back to displayName", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
      ),
    ).toBe("My Chat");
  });

  it("uses parsed fallback when whitespace-only label and no displayName", () => {
    expect(
      resolveSessionDisplayName("discord:123:456", row({ key: "discord:123:456", label: "   " })),
    ).toBe("Discord Session");
  });

  it("trims label and displayName", () => {
    expect(resolveSessionDisplayName("k", row({ key: "k", label: "  General  " }))).toBe("General");
    expect(resolveSessionDisplayName("k", row({ key: "k", displayName: "  My Chat  " }))).toBe(
      "My Chat",
    );
  });

  // ── Type prefixes applied to labels / displayNames ──

  it("prefixes subagent label with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
      ),
    ).toBe("Subagent: maintainer-v2");
  });

  it("prefixes subagent displayName with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
      ),
    ).toBe("Subagent: Task Runner");
  });

  it("prefixes cron label with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
      ),
    ).toBe("Cron: daily-briefing");
  });

  it("prefixes cron displayName with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix cron labels that already include Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix subagent display names that already include Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
      ),
    ).toBe("Subagent: Runner");
  });

  it("does not prefix non-typed sessions with labels", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:bluebubbles:direct:+19257864429",
        row({ key: "agent:main:bluebubbles:direct:+19257864429", label: "Tyler" }),
      ),
    ).toBe("Tyler");
  });
});

/* ================================================================
 *  resolveSessionOptions – dropdown option generation
 * ================================================================ */

describe("resolveSessionOptions", () => {
  it("includes configured agents without active sessions", () => {
    const agentsList = agents(["main", "ops", "research"]);
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([]),
      "agent:main:main",
      agentsList,
    );
    const keys = result.map((o) => o.key);
    expect(keys).toContain("agent:main:main");
    expect(keys).toContain("agent:ops:main");
    expect(keys).toContain("agent:research:main");
  });

  it("does not duplicate agents that already have sessions", () => {
    const agentsList = agents(["main", "ops"]);
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([
        row({ key: "agent:main:main", label: "Main" }),
        row({ key: "agent:ops:main", label: "Ops" }),
      ]),
      "agent:main:main",
      agentsList,
    );
    const keys = result.map((o) => o.key);
    const mainCount = keys.filter((k) => k === "agent:main:main").length;
    const opsCount = keys.filter((k) => k === "agent:ops:main").length;
    expect(mainCount).toBe(1);
    expect(opsCount).toBe(1);
  });

  it("uses custom mainKey from agents list", () => {
    const agentsList = agents(["main", "ops"], { mainKey: "work" });
    const result = resolveSessionOptions(
      "agent:main:work",
      sessions([]),
      "agent:main:work",
      agentsList,
    );
    const keys = result.map((o) => o.key);
    expect(keys).toContain("agent:ops:work");
  });

  it("uses agent identity name as display name", () => {
    const agentsList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "ops", name: "Operations", identity: { name: "Ops Bot" } }],
    };
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([]),
      "agent:main:main",
      agentsList,
    );
    const opsOption = result.find((o) => o.key === "agent:ops:main");
    expect(opsOption?.displayName).toBe("Ops Bot");
  });

  it("falls back to agent name when identity name is absent", () => {
    const agentsList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "ops", name: "Operations" }],
    };
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([]),
      "agent:main:main",
      agentsList,
    );
    const opsOption = result.find((o) => o.key === "agent:ops:main");
    expect(opsOption?.displayName).toBe("Operations");
  });

  it("falls back to agent id when no name is available", () => {
    const agentsList = agents(["main", "ops"]);
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([]),
      "agent:main:main",
      agentsList,
    );
    const opsOption = result.find((o) => o.key === "agent:ops:main");
    expect(opsOption?.displayName).toBe("ops");
  });

  it("works without agents list (backward compatible)", () => {
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([row({ key: "agent:main:main" })]),
      "agent:main:main",
    );
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("agent:main:main");
  });

  it("preserves session entries alongside agent entries", () => {
    const agentsList = agents(["main", "ops"]);
    const result = resolveSessionOptions(
      "agent:main:main",
      sessions([
        row({ key: "agent:main:main" }),
        row({ key: "agent:main:telegram:direct:user1", label: "Tyler" }),
      ]),
      "agent:main:main",
      agentsList,
    );
    const keys = result.map((o) => o.key);
    expect(keys).toContain("agent:main:main");
    expect(keys).toContain("agent:ops:main");
    expect(keys).toContain("agent:main:telegram:direct:user1");
  });
});
