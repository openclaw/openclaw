/**
 * Tests for the utility functions that were part of the agent-transcript script
 * (deleted in the .agents skills cleanup PR). These functions are inlined here
 * to preserve behavioral documentation and regression coverage.
 *
 * Source: .agents/skills/agent-transcript/scripts/agent-transcript (removed)
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inlined pure utility functions extracted from the deleted agent-transcript script
// ---------------------------------------------------------------------------

const MARKER_START = "<!-- agent-transcript:start -->";
const MARKER_END = "<!-- agent-transcript:end -->";

function parseArgs(argv: string[]): Record<string, string | string[] | boolean | true> & { _: string[] } {
  const args: Record<string, string | string[] | boolean | true> & { _: string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    i++;
    if (args[key] == null) {
      args[key] = next;
    } else if (Array.isArray(args[key])) {
      (args[key] as string[]).push(next);
    } else {
      args[key] = [args[key] as string, next];
    }
  }
  return args;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function replaceSection(body: string, section: string): string {
  const start = body.indexOf(MARKER_START);
  const end = body.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${body.slice(0, start).trimEnd()}\n\n${section.trim()}\n\n${body.slice(end + MARKER_END.length).trimStart()}`;
  }
  return `${body.trimEnd()}\n\n${section.trim()}\n`;
}

function escapeHtml(text: string): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function entryRole(entry: string): string | null {
  const match = entry.match(/^\[([^\]]+)\]\n/);
  return match ? match[1] : null;
}

function entryBody(entry: string): string {
  return entry.replace(/^\[[^\]]+\]\n/, "");
}

function coalesceEntries(entries: string[]): string[] {
  const coalesced: string[] = [];
  for (const entry of entries) {
    const role = entryRole(entry);
    const body = entryBody(entry);
    const last = coalesced[coalesced.length - 1];
    if (!last || !role || entryRole(last) !== role || role === "tool summary") {
      coalesced.push(entry);
      continue;
    }
    const lastBody = entryBody(last);
    if (lastBody === body || lastBody.includes(body)) continue;
    if (body.includes(lastBody)) {
      coalesced[coalesced.length - 1] = `[${role}]\n${body}`;
      continue;
    }
    coalesced[coalesced.length - 1] = `[${role}]\n${lastBody}\n\n${body}`;
  }
  return coalesced;
}

function toolFamily(name: string): string {
  const normalized = String(name).toLowerCase();
  if (
    /(read|fetch|open|list|find|search|grep|rg|sed|cat|head|tail|jq|wc|status|diff|show|view|snapshot|screenshot)/.test(
      normalized,
    )
  ) {
    return "read";
  }
  if (/(write|edit|patch|apply|create|update|append|save|comment|fill|click|type|navigate|upload)/.test(normalized)) {
    return "write";
  }
  if (/(exec|command|shell|run|test|build|lint|format|install|pnpm|npm|node|git|gh|ssh)/.test(normalized)) {
    return "execute";
  }
  if (/(web|http|fetch|browser|chrome|github|dropbox|notion|gmail|calendar)/.test(normalized)) {
    return "network";
  }
  return "other";
}

function shellFamily(command: string): string {
  const cmd = String(command || "").trim();
  if (!cmd) return "execute";
  if (
    /^(rg|grep|sed|cat|head|tail|jq|wc|ls|find|pwd|git (status|diff|show|log|blame)|gh (pr|issue|api|run|repo|auth) (view|list|status)|test |stat |ps |which |command -v )\b/.test(
      cmd,
    )
  ) {
    return "read";
  }
  if (/^(open |chmod |mkdir |touch |cp |mv |kill |git add|git commit|git push|gh pr create|gh issue create)\b/.test(cmd)) {
    return "write";
  }
  if (/^(node|npm|pnpm|bun|python|python3|ruby|tsx|tsgo|make|cargo|go test|swift|xcodebuild)\b/.test(cmd)) {
    return "execute";
  }
  if (/^(ssh|curl|wget|tailscale|nc )\b/.test(cmd)) return "network";
  return "execute";
}

type RedactStats = { redactions: number };

function redact(input: string, stats: RedactStats): string {
  let s = String(input ?? "");
  const rules: [RegExp, string][] = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
    [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
    [/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]"],
    [/(AKIA[0-9A-Z]{16})/g, "[REDACTED_AWS_KEY]"],
    [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
    [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[REDACTED_AUTH_HEADER]"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
    [/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[REDACTED_PHONE]"],
    [/\/Users\/[^\s`"'>)]+/g, "[LOCAL_PATH]"],
    [/~\/[^\s`"'>)]+/g, "[HOME_PATH]"],
    [/([?&](?:token|key|secret|signature|sig|access_token|auth)=)[^\s`"'>&]+/gi, "$1[REDACTED]"],
  ];
  for (const [re, repl] of rules) {
    const before = s;
    s = s.replace(re, repl);
    if (s !== before) stats.redactions++;
  }
  return s;
}

function unsafe(text: string): string[] {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\b(?:user_session|_gh_sess|__Host-user_session_same_site|GH_SESSION_TOKEN)\b/i,
    /\b(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/,
    /\/upload\/policies\/assets|uploadToken|authenticity_token/i,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

function stringContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringContent).filter(Boolean).join("\n");
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.message === "string") return obj.message;
    if (Array.isArray(obj.content)) return stringContent(obj.content);
    if (obj.type === "text" && obj.text) return String(obj.text);
  }
  return "";
}

function hasSetupBlob(text: string): boolean {
  return (
    text.includes("<INSTRUCTIONS>") ||
    text.includes("# AGENTS.MD") ||
    text.includes("Knowledge cutoff:") ||
    text.includes("You are Codex") ||
    /\byour instructions\b/i.test(text) ||
    /\binstructions absorbed\b/i.test(text) ||
    /\bAGENTS\.md\b/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses positional arguments", () => {
    const result = parseArgs(["find", "render"]);
    expect(result._).toEqual(["find", "render"]);
  });

  it("parses a simple --key value pair", () => {
    const result = parseArgs(["--query", "my search text"]);
    expect(result.query).toBe("my search text");
  });

  it("parses a boolean flag with no following value", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("parses a boolean flag when followed by another flag", () => {
    const result = parseArgs(["--dry-run", "--verbose"]);
    expect(result["dry-run"]).toBe(true);
    expect(result.verbose).toBe(true);
  });

  it("collects repeated keys into an array", () => {
    const result = parseArgs(["--root", "/path/a", "--root", "/path/b"]);
    expect(result.root).toEqual(["/path/a", "/path/b"]);
  });

  it("collects three or more repeated keys correctly", () => {
    const result = parseArgs(["--root", "a", "--root", "b", "--root", "c"]);
    expect(result.root).toEqual(["a", "b", "c"]);
  });

  it("handles mixed positional args and flags", () => {
    const result = parseArgs(["find", "--query", "hello", "--max-files", "200"]);
    expect(result._).toEqual(["find"]);
    expect(result.query).toBe("hello");
    expect(result["max-files"]).toBe("200");
  });

  it("returns empty arrays and no keys for empty input", () => {
    const result = parseArgs([]);
    expect(result._).toEqual([]);
    expect(Object.keys(result).filter((k) => k !== "_")).toHaveLength(0);
  });
});

describe("asArray", () => {
  it("wraps a single string in an array", () => {
    expect(asArray("hello")).toEqual(["hello"]);
  });

  it("returns an existing array unchanged", () => {
    expect(asArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty array for null", () => {
    expect(asArray(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(asArray(undefined)).toEqual([]);
  });

  it("wraps a number in an array", () => {
    expect(asArray(42)).toEqual([42]);
  });
});

describe("replaceSection", () => {
  it("appends section when no markers are present", () => {
    const result = replaceSection("existing body", "new section");
    expect(result).toBe("existing body\n\nnew section\n");
  });

  it("replaces an existing marked section", () => {
    const body = `intro\n\n${MARKER_START}\nold transcript\n${MARKER_END}\n\noutro`;
    const result = replaceSection(body, "new transcript");
    expect(result).toContain("new transcript");
    expect(result).not.toContain("old transcript");
    expect(result).toContain("intro");
    expect(result).toContain("outro");
  });

  it("preserves content before and after the markers", () => {
    const body = `## Summary\n\n${MARKER_START}\nstale\n${MARKER_END}\n\n## Footer`;
    const result = replaceSection(body, "fresh");
    expect(result).toContain("## Summary");
    expect(result).toContain("## Footer");
    expect(result).toContain("fresh");
  });

  it("does not duplicate the section when markers are absent", () => {
    const body = "plain body";
    const result = replaceSection(body, "section text");
    expect(result.split("section text").length - 1).toBe(1);
  });

  it("trims whitespace from end of existing body before appending", () => {
    const result = replaceSection("body   ", "section");
    expect(result.startsWith("body\n\n")).toBe(true);
  });

  it("ignores markers when end marker precedes start marker", () => {
    const body = `${MARKER_END}\n...\n${MARKER_START}`;
    const result = replaceSection(body, "inserted");
    expect(result).toContain("inserted");
    // Since end < start, no replacement occurs – section is appended
    expect(result.endsWith("inserted\n")).toBe(true);
  });
});

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than signs", () => {
    expect(escapeHtml("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes greater-than signs", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"quoted"')).toBe("&quot;quoted&quot;");
  });

  it("leaves safe characters unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });

  it("handles the empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special characters in one pass", () => {
    expect(escapeHtml('<a href="x&y">text</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;text&lt;/a&gt;",
    );
  });
});

describe("entryRole / entryBody", () => {
  it("extracts the role from a well-formed entry", () => {
    expect(entryRole("[user]\nhello")).toBe("user");
    expect(entryRole("[assistant]\nresponse")).toBe("assistant");
    expect(entryRole("[tool summary]\nstats")).toBe("tool summary");
  });

  it("returns null for an entry without a role header", () => {
    expect(entryRole("plain text")).toBeNull();
  });

  it("extracts the body content after the role header", () => {
    expect(entryBody("[user]\nhello world")).toBe("hello world");
    expect(entryBody("[assistant]\nline1\nline2")).toBe("line1\nline2");
  });

  it("returns the original string when no role header is present", () => {
    expect(entryBody("no header here")).toBe("no header here");
  });
});

describe("coalesceEntries", () => {
  it("returns an empty array for empty input", () => {
    expect(coalesceEntries([])).toEqual([]);
  });

  it("returns a single-element array unchanged", () => {
    const entry = "[user]\nhello";
    expect(coalesceEntries([entry])).toEqual([entry]);
  });

  it("merges adjacent same-role entries whose bodies differ", () => {
    const result = coalesceEntries(["[user]\npart one", "[user]\npart two"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("part one");
    expect(result[0]).toContain("part two");
  });

  it("deduplicates identical adjacent entries", () => {
    const entry = "[assistant]\nresponse text";
    const result = coalesceEntries([entry, entry]);
    expect(result).toHaveLength(1);
  });

  it("keeps entries with different roles separate", () => {
    const result = coalesceEntries(["[user]\nhello", "[assistant]\nhi", "[user]\nbye"]);
    expect(result).toHaveLength(3);
  });

  it("replaces earlier body when later body is a superset", () => {
    const result = coalesceEntries(["[user]\nshort", "[user]\nshort and more"]);
    expect(result).toHaveLength(1);
    expect(entryBody(result[0])).toBe("short and more");
  });

  it("never merges tool summary entries", () => {
    const result = coalesceEntries([
      "[tool summary]\n1 read",
      "[tool summary]\n2 read",
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("toolFamily", () => {
  it("classifies read-like tools as 'read'", () => {
    expect(toolFamily("readFile")).toBe("read");
    expect(toolFamily("search_code")).toBe("read");
    expect(toolFamily("grep_search")).toBe("read");
    expect(toolFamily("list_directory")).toBe("read");
    expect(toolFamily("view_file")).toBe("read");
    expect(toolFamily("screenshot")).toBe("read");
  });

  it("classifies write-like tools as 'write'", () => {
    expect(toolFamily("write_file")).toBe("write");
    expect(toolFamily("edit_file")).toBe("write");
    expect(toolFamily("create_file")).toBe("write");
    expect(toolFamily("update_record")).toBe("write");
    expect(toolFamily("add_comment")).toBe("write");
  });

  it("classifies exec-like tools as 'execute'", () => {
    expect(toolFamily("exec_command")).toBe("execute");
    expect(toolFamily("run_tests")).toBe("execute");
    expect(toolFamily("build_project")).toBe("execute");
    expect(toolFamily("shell_run")).toBe("execute");
  });

  it("classifies network tools as 'network'", () => {
    expect(toolFamily("web_search")).toBe("network");
    expect(toolFamily("http_fetch")).toBe("network");
    expect(toolFamily("github_api")).toBe("network");
    expect(toolFamily("browser_navigate")).toBe("network");
  });

  it("classifies unknown tools as 'other'", () => {
    expect(toolFamily("unknown_tool_xyz")).toBe("other");
    expect(toolFamily("")).toBe("other");
  });
});

describe("shellFamily", () => {
  it("classifies read-only shell commands", () => {
    expect(shellFamily("rg foo src/")).toBe("read");
    expect(shellFamily("grep -r pattern .")).toBe("read");
    expect(shellFamily("cat file.txt")).toBe("read");
    expect(shellFamily("git status")).toBe("read");
    expect(shellFamily("git diff HEAD")).toBe("read");
    expect(shellFamily("git show abc123")).toBe("read");
    expect(shellFamily("git log --oneline")).toBe("read");
    expect(shellFamily("gh pr view 42")).toBe("read");
  });

  it("classifies write shell commands", () => {
    expect(shellFamily("git add src/file.ts")).toBe("write");
    expect(shellFamily("git commit -m 'msg'")).toBe("write");
    expect(shellFamily("git push origin main")).toBe("write");
    expect(shellFamily("mkdir -p dist/")).toBe("write");
    expect(shellFamily("gh pr create")).toBe("write");
  });

  it("classifies execute shell commands", () => {
    expect(shellFamily("node index.js")).toBe("execute");
    expect(shellFamily("npm run build")).toBe("execute");
    expect(shellFamily("pnpm test")).toBe("execute");
    expect(shellFamily("python3 script.py")).toBe("execute");
  });

  it("classifies network shell commands", () => {
    expect(shellFamily("curl https://example.com")).toBe("network");
    expect(shellFamily("wget http://example.com/file")).toBe("network");
    expect(shellFamily("ssh user@host")).toBe("network");
  });

  it("classifies empty command as execute", () => {
    expect(shellFamily("")).toBe("execute");
  });

  it("classifies unknown command as execute", () => {
    expect(shellFamily("some-unknown-binary --flag")).toBe("execute");
  });
});

describe("redact", () => {
  it("redacts OpenAI API keys", () => {
    const stats = { redactions: 0 };
    const result = redact("key=sk-abcdefghijklmnopqrstuvwxyz1234567890", stats);
    expect(result).toContain("[REDACTED_OPENAI_KEY]");
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts GitHub tokens", () => {
    const stats = { redactions: 0 };
    const result = redact("token=ghp_abcdefghijklmnopqrstuvwxyz123456", stats);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts AWS access keys", () => {
    const stats = { redactions: 0 };
    const result = redact("aws_key=AKIAIOSFODNN7EXAMPLE", stats);
    expect(result).toContain("[REDACTED_AWS_KEY]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts Bearer auth headers", () => {
    const stats = { redactions: 0 };
    const result = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234", stats);
    expect(result).toContain("[REDACTED_AUTH_HEADER]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts email addresses", () => {
    const stats = { redactions: 0 };
    const result = redact("contact: user@example.com", stats);
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts local /Users/ paths", () => {
    const stats = { redactions: 0 };
    const result = redact("path: /Users/johndoe/projects/myapp", stats);
    expect(result).toContain("[LOCAL_PATH]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts home-relative paths with ~/", () => {
    const stats = { redactions: 0 };
    const result = redact("config: ~/Documents/config.json", stats);
    expect(result).toContain("[HOME_PATH]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("redacts token query parameters", () => {
    const stats = { redactions: 0 };
    const result = redact("url: https://example.com/api?token=supersecret123", stats);
    expect(result).toContain("[REDACTED]");
    expect(stats.redactions).toBeGreaterThan(0);
  });

  it("leaves safe text unchanged and does not increment redactions", () => {
    const stats = { redactions: 0 };
    const safe = "This is a normal message with no secrets.";
    const result = redact(safe, stats);
    expect(result).toBe(safe);
    expect(stats.redactions).toBe(0);
  });

  it("handles multiple redaction patterns in the same string", () => {
    const stats = { redactions: 0 };
    const result = redact(
      "user@example.com used key sk-abcdefghijklmnopqrstuvwxyz123456789 from /Users/bob/home",
      stats,
    );
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("[REDACTED_OPENAI_KEY]");
    expect(result).toContain("[LOCAL_PATH]");
    expect(stats.redactions).toBeGreaterThanOrEqual(3);
  });

  it("redacts private key blocks", () => {
    const stats = { redactions: 0 };
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const result = redact(pem, stats);
    expect(result).toContain("[REDACTED_PRIVATE_KEY]");
    expect(stats.redactions).toBeGreaterThan(0);
  });
});

describe("unsafe", () => {
  it("detects private key headers", () => {
    const findings = unsafe("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects Bearer auth headers", () => {
    const findings = unsafe("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects GITHUB_TOKEN environment variable names", () => {
    const findings = unsafe("export GITHUB_TOKEN=abc");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects OPENAI_API_KEY references", () => {
    const findings = unsafe("OPENAI_API_KEY=sk-...");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects GH_TOKEN references", () => {
    const findings = unsafe("GH_TOKEN=ghp_...");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects session cookie names", () => {
    const findings = unsafe("cookie: user_session=abc123");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("detects uploadToken references", () => {
    const findings = unsafe("uploadToken=abc123xyz");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("returns empty array for safe text", () => {
    const findings = unsafe("This is safe text with no secrets");
    expect(findings).toHaveLength(0);
  });
});

describe("stringContent", () => {
  it("returns empty string for null", () => {
    expect(stringContent(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(stringContent(undefined)).toBe("");
  });

  it("returns the string itself for string input", () => {
    expect(stringContent("hello")).toBe("hello");
  });

  it("joins an array of strings with newlines, filtering empty", () => {
    expect(stringContent(["a", "b", "c"])).toBe("a\nb\nc");
  });

  it("filters empty items from arrays", () => {
    expect(stringContent(["a", "", "b"])).toBe("a\nb");
  });

  it("extracts .text from an object", () => {
    expect(stringContent({ text: "from text field" })).toBe("from text field");
  });

  it("extracts .content string from an object", () => {
    expect(stringContent({ content: "from content field" })).toBe("from content field");
  });

  it("extracts .message string from an object", () => {
    expect(stringContent({ message: "from message field" })).toBe("from message field");
  });

  it("recursively extracts .content array from an object", () => {
    expect(stringContent({ content: ["line1", "line2"] })).toBe("line1\nline2");
  });

  it("extracts text from a type:text object", () => {
    expect(stringContent({ type: "text", text: "typed text" })).toBe("typed text");
  });

  it("returns empty string for an object with no recognizable fields", () => {
    expect(stringContent({ unknown: "value" })).toBe("");
  });
});

describe("hasSetupBlob", () => {
  it("detects <INSTRUCTIONS> marker", () => {
    expect(hasSetupBlob("<INSTRUCTIONS>some setup</INSTRUCTIONS>")).toBe(true);
  });

  it("detects # AGENTS.MD header", () => {
    expect(hasSetupBlob("# AGENTS.MD\nsome config")).toBe(true);
  });

  it("detects Knowledge cutoff prefix", () => {
    expect(hasSetupBlob("Knowledge cutoff: January 2025")).toBe(true);
  });

  it("detects 'You are Codex' preamble", () => {
    expect(hasSetupBlob("You are Codex, an AI assistant")).toBe(true);
  });

  it("detects 'your instructions' phrase case-insensitively", () => {
    expect(hasSetupBlob("Here are Your Instructions for this task")).toBe(true);
  });

  it("detects 'instructions absorbed' phrase", () => {
    expect(hasSetupBlob("Instructions absorbed. Ready to proceed.")).toBe(true);
  });

  it("detects AGENTS.md reference", () => {
    expect(hasSetupBlob("Loaded from AGENTS.md")).toBe(true);
  });

  it("returns false for regular conversational text", () => {
    expect(hasSetupBlob("Please help me refactor this function.")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(hasSetupBlob("")).toBe(false);
  });
});