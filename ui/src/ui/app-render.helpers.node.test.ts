import { describe, expect, it } from "vitest";
import {
  buildChatModelOptions,
  isCronSessionKey,
  parseSessionKey,
  resolveSessionDisplayName,
} from "./app-render.helpers.ts";
import type { ModelCatalogEntry, SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
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
    expect(parseSessionKey("cron:daily-briefing-uuid")).toEqual({
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

describe("isCronSessionKey", () => {
  it("returns true for cron: prefixed keys", () => {
    expect(isCronSessionKey("cron:abc-123")).toBe(true);
    expect(isCronSessionKey("cron:weekly-agent-roundtable")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123:run:run-1")).toBe(true);
  });

  it("returns false for non-cron keys", () => {
    expect(isCronSessionKey("main")).toBe(false);
    expect(isCronSessionKey("discord:group:eng")).toBe(false);
    expect(isCronSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
  });
});

/* ================================================================
 *  buildChatModelOptions – deduplication with normalized model refs
 * ================================================================ */

describe("buildChatModelOptions", () => {
  const catalog: ModelCatalogEntry[] = [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex" },
    { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
  ];

  it("returns one entry per catalog model with the provider label", () => {
    const options = buildChatModelOptions(catalog, "", "");
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual({ value: "gpt-5.4", label: "gpt-5.4 · openai-codex" });
    expect(options[1]).toEqual({ value: "claude-opus-5", label: "claude-opus-5 · anthropic" });
  });

  it("does not add a duplicate when currentOverride is the bare catalog id", () => {
    // "gpt-5.4" is already in the catalog; it should not appear twice.
    const options = buildChatModelOptions(catalog, "gpt-5.4", "");
    expect(options).toHaveLength(2);
    expect(options.filter((o) => o.value === "gpt-5.4")).toHaveLength(1);
  });

  it("keeps the qualified override value selectable when currentOverride is the provider-qualified ref", () => {
    // "openai-codex/gpt-5.4" resolves to the same catalog entry as bare "gpt-5.4".
    // The option must use the qualified value so entry.value === currentOverride holds.
    const options = buildChatModelOptions(catalog, "openai-codex/gpt-5.4", "");
    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("openai-codex/gpt-5.4");
    expect(options[0].label).toBe("gpt-5.4 · openai-codex");
  });

  it("does not add a duplicate when defaultModel is the bare catalog id", () => {
    const options = buildChatModelOptions(catalog, "", "gpt-5.4");
    expect(options).toHaveLength(2);
  });

  it("does not add a duplicate when defaultModel is the qualified form", () => {
    // Qualified defaultModel resolves to the same catalog entry — no extra option.
    // The option value stays as the bare catalog id; only currentOverride needs
    // exact-value matching for the select element.
    const options = buildChatModelOptions(catalog, "", "openai-codex/gpt-5.4");
    expect(options).toHaveLength(2);
  });

  it("does not duplicate when currentOverride and defaultModel are both the bare id", () => {
    const options = buildChatModelOptions(catalog, "gpt-5.4", "gpt-5.4");
    expect(options).toHaveLength(2);
  });

  it("does not duplicate when override is bare and defaultModel is qualified (or vice versa)", () => {
    // bare override + qualified default: override is bare, catalog entry already has value="gpt-5.4",
    // no in-place update needed, so option stays as bare id
    const a = buildChatModelOptions(catalog, "gpt-5.4", "openai-codex/gpt-5.4");
    expect(a).toHaveLength(2);
    // option value stays as the catalog bare id; override "gpt-5.4" matches it exactly
    expect(a[0].value).toBe("gpt-5.4");

    // qualified override + bare default: override is qualified, option value becomes qualified
    // so that entry.value === currentOverride holds in the select element
    const b = buildChatModelOptions(catalog, "openai-codex/gpt-5.4", "gpt-5.4");
    expect(b).toHaveLength(2);
    expect(b[0].value).toBe("openai-codex/gpt-5.4");
  });

  it("adds an unknown override as a new entry (not in catalog)", () => {
    const options = buildChatModelOptions(catalog, "some-custom-model", "");
    expect(options).toHaveLength(3);
    expect(options[2]).toEqual({ value: "some-custom-model", label: "some-custom-model" });
  });

  it("handles a catalog-only model with no provider without error", () => {
    const noProv: ModelCatalogEntry[] = [{ id: "local-llm", name: "Local LLM", provider: "" }];
    const options = buildChatModelOptions(noProv, "local-llm", "");
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({ value: "local-llm", label: "local-llm" });
  });

  it("handles Docker-style model ids with slashes correctly", () => {
    const dockerCatalog: ModelCatalogEntry[] = [
      { id: "docker.io/ai/gpt-oss:latest", name: "GPT OSS", provider: "docker" },
    ];
    // The bare id contains slashes but is still a bare (unqualified) ref.
    const options = buildChatModelOptions(dockerCatalog, "docker.io/ai/gpt-oss:latest", "");
    expect(options).toHaveLength(1);
  });
});
