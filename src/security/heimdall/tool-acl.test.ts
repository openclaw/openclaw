import { describe, expect, it } from "vitest";
import { globToRegex, isToolAllowed } from "./tool-acl.js";
import { SenderTier } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const deny = { defaultGuestPolicy: "deny" as const };
const readOnly = { defaultGuestPolicy: "read-only" as const };
const noACL = { ...deny, toolACL: [] };

// ---------------------------------------------------------------------------
// OWNER bypass
// ---------------------------------------------------------------------------

describe("OWNER bypass", () => {
  it("allows any arbitrary tool for OWNER", () => {
    expect(isToolAllowed("exec", SenderTier.OWNER, deny)).toBe(true);
    expect(isToolAllowed("write", SenderTier.OWNER, deny)).toBe(true);
    expect(isToolAllowed("totally_unknown_tool", SenderTier.OWNER, deny)).toBe(true);
    expect(isToolAllowed("mcp__server__execute_command", SenderTier.OWNER, deny)).toBe(true);
  });

  it("OWNER bypass cannot be restricted by custom ACL", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "exec", allowedTiers: [SenderTier.GUEST] }],
    };
    // Even though the ACL only lists GUEST, OWNER still gets through
    expect(isToolAllowed("exec", SenderTier.OWNER, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEMBER — default safe tools
// ---------------------------------------------------------------------------

describe("MEMBER default safe tools", () => {
  const safes = [
    "search",
    "read",
    "sessions_list",
    "sessions_history",
    "session_status",
    "image",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "agents_list",
  ];

  it.each(safes)("allows MEMBER to use %s", (tool) => {
    expect(isToolAllowed(tool, SenderTier.MEMBER, noACL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEMBER — dangerous tools denied
// ---------------------------------------------------------------------------

describe("MEMBER denied dangerous tools", () => {
  const dangerous = ["exec", "process", "write", "edit", "apply_patch"];

  it.each(dangerous)("denies MEMBER from using %s", (tool) => {
    expect(isToolAllowed(tool, SenderTier.MEMBER, noACL)).toBe(false);
  });

  it("denies MEMBER from sandboxed variants", () => {
    expect(isToolAllowed("sandboxed_write", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("sandboxed_edit", SenderTier.MEMBER, noACL)).toBe(false);
  });

  it("denies MEMBER from MCP dangerous patterns", () => {
    expect(isToolAllowed("mcp__github__execute_command", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("mcp__server__write_file", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("mcp__fs__delete_entry", SenderTier.MEMBER, noACL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GUEST — deny policy
// ---------------------------------------------------------------------------

describe("GUEST with deny policy", () => {
  it("denies ALL tools for GUEST when defaultGuestPolicy is deny", () => {
    expect(isToolAllowed("search", SenderTier.GUEST, deny)).toBe(false);
    expect(isToolAllowed("read", SenderTier.GUEST, deny)).toBe(false);
    expect(isToolAllowed("exec", SenderTier.GUEST, deny)).toBe(false);
    expect(isToolAllowed("memory_search", SenderTier.GUEST, deny)).toBe(false);
    expect(isToolAllowed("agents_list", SenderTier.GUEST, deny)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GUEST — read-only policy
// ---------------------------------------------------------------------------

describe("GUEST with read-only policy", () => {
  const readOnlyTools = [
    "search",
    "read",
    "sessions_list",
    "sessions_history",
    "session_status",
    "image",
    "memory_search",
  ];

  it.each(readOnlyTools)("allows GUEST to use %s in read-only mode", (tool) => {
    expect(isToolAllowed(tool, SenderTier.GUEST, readOnly)).toBe(true);
  });

  it("still denies GUEST from dangerous tools in read-only mode", () => {
    expect(isToolAllowed("exec", SenderTier.GUEST, readOnly)).toBe(false);
    expect(isToolAllowed("write", SenderTier.GUEST, readOnly)).toBe(false);
    expect(isToolAllowed("edit", SenderTier.GUEST, readOnly)).toBe(false);
  });

  it("denies GUEST from non-read-only safe tools like agents_list", () => {
    expect(isToolAllowed("agents_list", SenderTier.GUEST, readOnly)).toBe(false);
    expect(isToolAllowed("memory_get", SenderTier.GUEST, readOnly)).toBe(false);
    expect(isToolAllowed("web_search", SenderTier.GUEST, readOnly)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("mcp__* matches mcp__github__list_repos", () => {
    const re = globToRegex("mcp__*");
    expect(re.test("mcp__github__list_repos")).toBe(true);
  });

  it("mcp__*__execute_* matches mcp__server__execute_command", () => {
    const re = globToRegex("mcp__*__execute_*");
    expect(re.test("mcp__server__execute_command")).toBe(true);
  });

  it("browser_* matches browser_navigate", () => {
    const re = globToRegex("browser_*");
    expect(re.test("browser_navigate")).toBe(true);
  });

  it("does not match unrelated strings", () => {
    const re = globToRegex("mcp__*");
    expect(re.test("search")).toBe(false);
    expect(re.test("xmcp__foo")).toBe(false);
  });

  it("exact pattern matches exactly", () => {
    const re = globToRegex("exec");
    expect(re.test("exec")).toBe(true);
    expect(re.test("execute")).toBe(false);
    expect(re.test("xexec")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Custom ACL overrides defaults
// ---------------------------------------------------------------------------

describe("custom ACL overrides", () => {
  it("allows MEMBER to use exec when custom ACL permits it", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "exec", allowedTiers: [SenderTier.MEMBER] }],
    };
    expect(isToolAllowed("exec", SenderTier.MEMBER, config)).toBe(true);
  });

  it("denies MEMBER when custom ACL does not include their tier", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "exec", allowedTiers: [SenderTier.GUEST] }],
    };
    expect(isToolAllowed("exec", SenderTier.MEMBER, config)).toBe(false);
  });

  it("custom ACL with glob overrides dangerous defaults", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "mcp__*__execute_*", allowedTiers: [SenderTier.MEMBER] }],
    };
    expect(isToolAllowed("mcp__server__execute_command", SenderTier.MEMBER, config)).toBe(true);
  });

  it("first matching ACL entry wins", () => {
    const config = {
      ...deny,
      toolACL: [
        { pattern: "exec", allowedTiers: [SenderTier.MEMBER] },
        { pattern: "exec", allowedTiers: [] as SenderTier[] },
      ],
    };
    // First entry matches and allows MEMBER
    expect(isToolAllowed("exec", SenderTier.MEMBER, config)).toBe(true);
  });

  it("falls through to defaults when no custom ACL entry matches", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "browser_*", allowedTiers: [SenderTier.MEMBER] }],
    };
    // "search" does not match "browser_*", falls through to default safe list
    expect(isToolAllowed("search", SenderTier.MEMBER, config)).toBe(true);
    // "exec" does not match "browser_*", falls through to dangerous default
    expect(isToolAllowed("exec", SenderTier.MEMBER, config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool → denied for non-OWNER
// ---------------------------------------------------------------------------

describe("unknown tools", () => {
  it("denies unknown tool for MEMBER", () => {
    expect(isToolAllowed("totally_made_up_tool", SenderTier.MEMBER, noACL)).toBe(false);
  });

  it("denies unknown tool for GUEST even in read-only mode", () => {
    expect(isToolAllowed("totally_made_up_tool", SenderTier.GUEST, readOnly)).toBe(false);
  });

  it("allows unknown tool for OWNER", () => {
    expect(isToolAllowed("totally_made_up_tool", SenderTier.OWNER, noACL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: glob escaping and config resilience
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("escapes regex special characters in glob patterns", () => {
    const re = globToRegex("tool.name+special");
    expect(re.test("tool.name+special")).toBe(true);
    expect(re.test("toolXname+special")).toBe(false);
    expect(re.test("tool.name+specialXXX")).toBe(false);
  });

  it("handles undefined toolACL (falls through to defaults)", () => {
    const config = { ...deny, toolACL: undefined };
    expect(isToolAllowed("search", SenderTier.MEMBER, config)).toBe(true);
    expect(isToolAllowed("exec", SenderTier.MEMBER, config)).toBe(false);
  });

  it("handles undefined defaultGuestPolicy (defaults to deny behavior)", () => {
    const config = { defaultGuestPolicy: undefined as unknown as "deny", toolACL: [] };
    expect(isToolAllowed("search", SenderTier.GUEST, config)).toBe(false);
  });

  it("GUEST can be granted access via custom ACL", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "custom_tool", allowedTiers: [SenderTier.GUEST] }],
    };
    expect(isToolAllowed("custom_tool", SenderTier.GUEST, config)).toBe(true);
  });

  it("empty pattern in ACL matches empty tool name only", () => {
    const re = globToRegex("");
    expect(re.test("")).toBe(true);
    expect(re.test("anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool name normalization
// ---------------------------------------------------------------------------

describe("tool name normalization", () => {
  it('normalizes "Bash" to "exec" and applies dangerous rule', () => {
    expect(isToolAllowed("Bash", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("Bash", SenderTier.OWNER, noACL)).toBe(true);
  });

  it('normalizes "BASH" to "exec" (case insensitive)', () => {
    expect(isToolAllowed("BASH", SenderTier.MEMBER, noACL)).toBe(false);
  });

  it("handles empty string tool name", () => {
    expect(isToolAllowed("", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("", SenderTier.OWNER, noACL)).toBe(true);
  });

  it('normalizes "apply-patch" to "apply_patch"', () => {
    expect(isToolAllowed("apply-patch", SenderTier.MEMBER, noACL)).toBe(false);
    expect(isToolAllowed("apply-patch", SenderTier.OWNER, noACL)).toBe(true);
  });

  it("trims whitespace in tool names", () => {
    expect(isToolAllowed("  read  ", SenderTier.MEMBER, noACL)).toBe(true);
    expect(isToolAllowed("  exec  ", SenderTier.MEMBER, noACL)).toBe(false);
  });

  it("normalization works with custom ACL", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "exec", allowedTiers: [SenderTier.MEMBER] }],
    };
    // "Bash" normalizes to "exec", which matches the custom ACL entry
    expect(isToolAllowed("Bash", SenderTier.MEMBER, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM tier — trusted internal runtime calls
// ---------------------------------------------------------------------------

describe("SYSTEM tier ACL", () => {
  it("allows SYSTEM to use MEMBER safe tools (conservative baseline)", () => {
    const safes = ["search", "read", "sessions_list", "memory_search", "web_search"];
    safes.forEach((tool) => {
      expect(isToolAllowed(tool, SenderTier.SYSTEM, noACL)).toBe(true);
    });
  });

  it("denies SYSTEM dangerous tools by default (no OWNER bypass)", () => {
    const dangerous = ["exec", "write", "edit", "apply_patch", "process"];
    dangerous.forEach((tool) => {
      expect(isToolAllowed(tool, SenderTier.SYSTEM, noACL)).toBe(false);
    });
  });

  it("denies SYSTEM MCP execute/write/delete patterns", () => {
    expect(isToolAllowed("mcp__server__execute_command", SenderTier.SYSTEM, noACL)).toBe(false);
    expect(isToolAllowed("mcp__fs__write_file", SenderTier.SYSTEM, noACL)).toBe(false);
    expect(isToolAllowed("mcp__db__delete_record", SenderTier.SYSTEM, noACL)).toBe(false);
  });

  it("respects custom ACL for SYSTEM tier", () => {
    const config = {
      ...deny,
      toolACL: [
        { pattern: "kg_query", allowedTiers: [SenderTier.SYSTEM, SenderTier.MEMBER] },
        { pattern: "telegram_send*", allowedTiers: [SenderTier.SYSTEM] },
      ],
    };
    expect(isToolAllowed("kg_query", SenderTier.SYSTEM, config)).toBe(true);
    expect(isToolAllowed("telegram_send_message", SenderTier.SYSTEM, config)).toBe(true);
    expect(isToolAllowed("exec", SenderTier.SYSTEM, config)).toBe(false);
  });

  it("denies SYSTEM tools not in safe list or custom ACL (fail-closed)", () => {
    expect(isToolAllowed("unknown_tool", SenderTier.SYSTEM, noACL)).toBe(false);
    expect(isToolAllowed("domain_resolve", SenderTier.SYSTEM, noACL)).toBe(false); // not in DEFAULT_MEMBER_SAFE
  });

  it("SYSTEM tier can be granted via custom ACL (explicit allow)", () => {
    const config = {
      ...deny,
      toolACL: [{ pattern: "session_heartbeat", allowedTiers: [SenderTier.SYSTEM] }],
    };
    expect(isToolAllowed("session_heartbeat", SenderTier.SYSTEM, config)).toBe(true);
    expect(isToolAllowed("session_heartbeat", SenderTier.MEMBER, config)).toBe(false);
  });
});
