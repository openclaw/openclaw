import { describe, expect, it } from "vitest";
import { isCronSessionDisplayKey, isSystemCreatedSessionRow } from "./session-list-visibility.js";

describe("session display visibility", () => {
  it.each([
    ["cron:", true],
    [" CRON:nightly ", true],
    ["cron", false],
    ["agent:main:cron:nightly", true],
    [" AGENT:MAIN:CRON:nightly ", true],
    ["agent::main::cron::nightly", true],
    ["agent: :cron:nightly", true],
    ["agent:\n:cron:nightly", true],
    ["agent:main:cron: :child", true],
    ["agent:main:cron:nightly:child", true],
    ["agent:main:cron:", false],
    ["agent:main:cron:   ", false],
    ["agent:main::cron::", false],
    ["agent::cron:nightly", false],
    ["agent:main:other:cron:nightly", false],
    ["agent:main:cronicle:nightly", false],
    ["agent:main:main", false],
    [":agent:main:cron:nightly", false],
    ["prefix:cron:nightly", false],
    ["", false],
  ] as const)("classifies %j as automation=%s", (key, expected) => {
    expect(isCronSessionDisplayKey(key)).toBe(expected);
  });

  it("keeps automation provenance separate from system-created probes", () => {
    expect(
      isSystemCreatedSessionRow({
        key: "agent::main::cron::nightly",
        createdActor: { type: "system" },
      }),
    ).toBe(false);
    expect(
      isSystemCreatedSessionRow({
        key: "agent:main:probe",
        createdVia: "internal",
        label: " ",
      }),
    ).toBe(true);
    expect(
      isSystemCreatedSessionRow({
        key: "agent:main:operator-work",
        createdVia: "run",
        createdActor: { type: "human" },
      }),
    ).toBe(false);
  });
});
