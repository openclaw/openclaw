import { describe, expect, it } from "vitest";
import {
  isCronSessionDisplayKey,
  isReservedGitHubPublicationSessionKey,
  isSystemCreatedSessionRow,
} from "./session-list-visibility.js";

describe("session display visibility", () => {
  it("recognizes reserved GitHub publication custody keys", () => {
    expect(
      isReservedGitHubPublicationSessionKey(
        "agent:main:dashboard:github-publication-e205588962dd675361e7676e2da8088e",
      ),
    ).toBe(true);
    expect(
      isReservedGitHubPublicationSessionKey(
        "agent:main:dashboard:github-0d8f7c2a-1b3e-8c4d-9a5f-6e7d8c9b0a1f",
      ),
    ).toBe(true);
    expect(
      isReservedGitHubPublicationSessionKey(
        "agent:main:dashboard:1e20cb43-8879-4156-8b1b-b90cf0ac08fd",
      ),
    ).toBe(false);
    expect(
      isReservedGitHubPublicationSessionKey(
        "agent:main:subagent:github-publication-e205588962dd675361e7676e2da8088e",
      ),
    ).toBe(false);
  });

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
      [
        {
          key: "agent:main:dashboard:incognito-random",
          createdSurface: "github-publication",
          label: "Renamed task",
        },
        true,
      ],
      [
        {
          key: "agent:main:dashboard:github-00000000-0000-8000-8000-000000000001",
          classification: "github-publication",
          createdVia: "spawn",
          createdActor: { type: "human" },
        },
        true,
      ],
    ];
    for (const [row, expected] of cases) {
      expect(isSystemCreatedSessionRow(row), row.key).toBe(expected);
    }
  });
});
