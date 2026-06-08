import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { formatAcpSessionLine } from "./diagnostics.js";

function makeEntry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    updatedAt: 0,
    acp: { agent: "codex", backend: "acpx", mode: "persistent", state: "idle" },
    ...over,
  } as SessionEntry;
}

describe("formatAcpSessionLine", () => {
  afterEach(() => vi.useRealTimers());

  it("includes spawn time (UTC) and relative last-active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T23:08:00Z"));
    const line = formatAcpSessionLine({
      key: "agent:codex:acp:abc",
      entry: makeEntry({
        sessionStartedAt: Date.UTC(2026, 5, 5, 21, 8),
        lastInteractionAt: Date.UTC(2026, 5, 5, 21, 8),
      }),
    });
    expect(line).toContain("spawned 2026-06-05 21:08Z");
    expect(line).toContain("last 2h ago");
    expect(line).toContain("-> agent:codex:acp:abc");
  });

  it("omits time segments when timestamps are missing", () => {
    const line = formatAcpSessionLine({
      key: "agent:codex:acp:xyz",
      entry: makeEntry(),
    });
    expect(line).not.toContain("spawned");
    expect(line).not.toContain("last ");
    expect(line).toContain("(persistent, idle, backend:acpx)");
    expect(line).toContain("-> agent:codex:acp:xyz");
  });
});
