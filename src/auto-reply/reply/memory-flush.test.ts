import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT, resolveMemoryFlushPromptForRun } from "./memory-flush.js";

describe("resolveMemoryFlushPromptForRun", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store durable notes in memory/YYYY-MM-DD.md",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("memory/2026-02-16.md");
    expect(prompt).toContain(
      "Current time: Monday, February 16th, 2026 — 10:00 AM (America/New_York) / 2026-02-16 15:00 UTC",
    );
  });

  it("does not append a duplicate current time line", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store notes.\nCurrent time: already present",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("Current time: already present");
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });
});

describe("DEFAULT_MEMORY_FLUSH_PROMPT", () => {
  it("includes append-only instruction to prevent overwrites (#6877)", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
  });

  it("includes anti-fragmentation instruction to prevent timestamped variant files (#34919)", () => {
    // Agents must not create YYYY-MM-DD-HHMM.md variants alongside the canonical file
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});

describe("computeContextHash", () => {
  // Import dynamically to avoid hoisting issues with vitest
  let computeContextHash: typeof import("./memory-flush.js").computeContextHash;

  beforeAll(async () => {
    const mod = await import("./memory-flush.js");
    computeContextHash = mod.computeContextHash;
  });

  it("returns a 16-char hex string", () => {
    const hash = computeContextHash([{ role: "user", content: "hello" }]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same hash for identical input", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(computeContextHash(msgs)).toBe(computeContextHash(msgs));
  });

  it("returns empty-array hash for empty input", () => {
    const hash = computeContextHash([]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("excludes system messages from content tail but length still differentiates", () => {
    const withSystem = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
    ];
    const withoutSystem = [{ role: "user", content: "hello" }];
    // Same user/assistant tail but different messages.length → different hash
    expect(computeContextHash(withSystem)).not.toBe(computeContextHash(withoutSystem));
  });

  it("different messages.length with same tail produces different hash", () => {
    const short = [{ role: "user", content: "hello" }];
    const long = [
      { role: "user", content: "older" },
      { role: "user", content: "hello" },
    ];
    // last user/assistant content is the same ("hello") but length differs
    expect(computeContextHash(short)).not.toBe(computeContextHash(long));
  });

  it("handles object content (non-string)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const hash = computeContextHash(msgs);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles undefined content", () => {
    const msgs = [{ role: "user", content: undefined }];
    const hash = computeContextHash(msgs);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("only uses last 3 user/assistant messages", () => {
    const base = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const extended = [{ role: "user", content: "EXTRA" }, ...base];
    // Both have same last 3 user/assistant but different lengths
    expect(computeContextHash(base)).not.toBe(computeContextHash(extended));
  });

  it("includes role in hash so same content under different roles produces different hash", () => {
    const asUser = [{ role: "user", content: "hello" }];
    const asAssistant = [{ role: "assistant", content: "hello" }];
    expect(computeContextHash(asUser)).not.toBe(computeContextHash(asAssistant));
  });
});
