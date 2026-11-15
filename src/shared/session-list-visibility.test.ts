import { describe, expect, it } from "vitest";
import { isCronSessionDisplayKey, isSystemCreatedSessionRow } from "./session-list-visibility.js";

describe("session display visibility", () => {
  it("classifies automation display keys", () => {
    const cases: [string, boolean][] = [
      ["cron:", true],
      ["cron", false],
      [" AGENT:MAIN:CRON:nightly ", true],
      ["agent::main::cron::nightly", true],
      ["agent:\n:cron:nightly", true],
      ["agent:main:cron: :child", true],
      ["agent:main:cron:   ", false],
      ["agent::cron:nightly", false],
      ["agent:main:cronicle:nightly", false],
    ];
    for (const [key, expected] of cases) {
      expect(isCronSessionDisplayKey(key), key).toBe(expected);
    }
  });

  it("separates automation and operator-named sessions from system-created lanes", () => {
    const cases: [Parameters<typeof isSystemCreatedSessionRow>[0], boolean][] = [
      [{ key: "agent::main::cron::nightly", createdActor: { type: "system" } }, false],
      [{ key: "agent:main:main:active-memory:abcdef123456" }, true],
      [{ key: "agent:main:dashboard:conversation:active-memory:abcdef123456" }, true],
      [{ key: "agent:main:active-memory:abcdef123456" }, true],
      [
        {
          key: "agent:main:main:active-memory:abcdef123456",
          displayName: "memory search agent",
        },
        true,
      ],
      [{ key: "agent:main:main", displayName: "memory search agent" }, false],
      [{ key: "agent:main:explicit:active-memory" }, false],
      [{ key: "agent:main:explicit:active-memory:not-a-recall" }, false],
      [{ key: "agent:main:main:active-memory:abcdef123456:child" }, false],
      [{ key: "agent:main:probe", createdVia: "internal", label: " " }, true],
      [
        { key: "agent:main:operator-work", createdVia: "run", createdActor: { type: "human" } },
        false,
      ],
      [
        {
          key: "agent:main:dashboard:00000000-0000-0000-0000-000000000000:heartbeat",
          classification: "heartbeat",
        },
        true,
      ],
      [
        {
          key: "agent:main:main:heartbeat",
          classification: "heartbeat",
          label: "Background watch",
        },
        false,
      ],
      [{ key: "agent:main:main", classification: "main" }, false],
    ];
    for (const [row, expected] of cases) {
      expect(isSystemCreatedSessionRow(row), row.key).toBe(expected);
    }
  });
});
