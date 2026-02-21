import { describe, expect, it } from "vitest";
import { parseSessionKey, resolveSessionDisplayName } from "./app-render.helpers.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("maps session keys to expected prefixes and fallback names", () => {
    const cases = [
      {
        name: "bare main",
        key: "main",
        expected: { prefix: "", fallbackName: "Main Session" },
      },
      {
        name: "agent main key",
        key: "agent:main:main",
        expected: { prefix: "", fallbackName: "Main Session" },
      },
      {
        name: "subagent key",
        key: "agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253",
        expected: { prefix: "Subagent:", fallbackName: "Subagent:" },
      },
      {
        name: "cron key",
        key: "agent:main:cron:daily-briefing-uuid",
        expected: { prefix: "Cron:", fallbackName: "Cron Job:" },
      },
      {
        name: "direct known channel",
        key: "agent:main:bluebubbles:direct:+19257864429",
        expected: { prefix: "", fallbackName: "iMessage · +19257864429" },
      },
      {
        name: "direct telegram",
        key: "agent:main:telegram:direct:user123",
        expected: { prefix: "", fallbackName: "Telegram · user123" },
      },
      {
        name: "group known channel",
        key: "agent:main:discord:group:guild-chan",
        expected: { prefix: "", fallbackName: "Discord Group" },
      },
      {
        name: "unknown channel direct",
        key: "agent:main:mychannel:direct:user1",
        expected: { prefix: "", fallbackName: "Mychannel · user1" },
      },
      {
        name: "legacy channel-prefixed key",
        key: "bluebubbles:g-agent-main-bluebubbles-direct-+19257864429",
        expected: { prefix: "", fallbackName: "iMessage Session" },
      },
      {
        name: "legacy discord key",
        key: "discord:123:456",
        expected: { prefix: "", fallbackName: "Discord Session" },
      },
      {
        name: "bare channel key",
        key: "telegram",
        expected: { prefix: "", fallbackName: "Telegram Session" },
      },
      {
        name: "unknown pattern",
        key: "something-unknown",
        expected: { prefix: "", fallbackName: "something-unknown" },
      },
    ] as const;
    for (const testCase of cases) {
      expect(parseSessionKey(testCase.key), testCase.name).toEqual(testCase.expected);
    }
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  it("resolves key-only fallbacks", () => {
    const cases = [
      { key: "agent:main:main", expected: "Main Session" },
      { key: "main", expected: "Main Session" },
      { key: "agent:main:subagent:abc-123", expected: "Subagent:" },
      { key: "agent:main:cron:abc-123", expected: "Cron Job:" },
      { key: "agent:main:bluebubbles:direct:+19257864429", expected: "iMessage · +19257864429" },
      { key: "discord:123:456", expected: "Discord Session" },
      { key: "something-custom", expected: "something-custom" },
    ] as const;
    for (const testCase of cases) {
      expect(resolveSessionDisplayName(testCase.key), testCase.key).toBe(testCase.expected);
    }
  });

  it("resolves row labels/display names and typed prefixes", () => {
    const cases = [
      {
        name: "row with no label/display",
        key: "agent:main:main",
        rowData: row({ key: "agent:main:main" }),
        expected: "Main Session",
      },
      {
        name: "displayName equals key",
        key: "mykey",
        rowData: row({ key: "mykey", displayName: "mykey" }),
        expected: "mykey",
      },
      {
        name: "label equals key",
        key: "mykey",
        rowData: row({ key: "mykey", label: "mykey" }),
        expected: "mykey",
      },
      {
        name: "label used",
        key: "discord:123:456",
        rowData: row({ key: "discord:123:456", label: "General" }),
        expected: "General",
      },
      {
        name: "displayName fallback",
        key: "discord:123:456",
        rowData: row({ key: "discord:123:456", displayName: "My Chat" }),
        expected: "My Chat",
      },
      {
        name: "label preferred over displayName",
        key: "discord:123:456",
        rowData: row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
        expected: "General",
      },
      {
        name: "ignore whitespace label",
        key: "discord:123:456",
        rowData: row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
        expected: "My Chat",
      },
      {
        name: "fallback when whitespace label and no displayName",
        key: "discord:123:456",
        rowData: row({ key: "discord:123:456", label: "   " }),
        expected: "Discord Session",
      },
      {
        name: "trim label",
        key: "k",
        rowData: row({ key: "k", label: "  General  " }),
        expected: "General",
      },
      {
        name: "trim displayName",
        key: "k",
        rowData: row({ key: "k", displayName: "  My Chat  " }),
        expected: "My Chat",
      },
      {
        name: "prefix subagent label",
        key: "agent:main:subagent:abc-123",
        rowData: row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
        expected: "Subagent: maintainer-v2",
      },
      {
        name: "prefix subagent displayName",
        key: "agent:main:subagent:abc-123",
        rowData: row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
        expected: "Subagent: Task Runner",
      },
      {
        name: "prefix cron label",
        key: "agent:main:cron:abc-123",
        rowData: row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
        expected: "Cron: daily-briefing",
      },
      {
        name: "prefix cron displayName",
        key: "agent:main:cron:abc-123",
        rowData: row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
        expected: "Cron: Nightly Sync",
      },
      {
        name: "avoid double cron prefix",
        key: "agent:main:cron:abc-123",
        rowData: row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
        expected: "Cron: Nightly Sync",
      },
      {
        name: "avoid double subagent prefix",
        key: "agent:main:subagent:abc-123",
        rowData: row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
        expected: "Subagent: Runner",
      },
      {
        name: "non-typed label without prefix",
        key: "agent:main:bluebubbles:direct:+19257864429",
        rowData: row({ key: "agent:main:bluebubbles:direct:+19257864429", label: "Tyler" }),
        expected: "Tyler",
      },
    ] as const;
    for (const testCase of cases) {
      expect(resolveSessionDisplayName(testCase.key, testCase.rowData), testCase.name).toBe(
        testCase.expected,
      );
    }
  });
});
