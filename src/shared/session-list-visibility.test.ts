import { describe, expect, it } from "vitest";
import { isCronSessionDisplayKey, isSystemCreatedSessionRow } from "./session-list-visibility.js";

describe("session display visibility", () => {
  it.each([
    ["cron:", true],
    ["cron", false],
    [" AGENT:MAIN:CRON:nightly ", true],
    ["agent::main::cron::nightly", true],
    ["agent:\n:cron:nightly", true],
    ["agent:main:cron: :child", true],
    ["agent:main:cron:   ", false],
    ["agent::cron:nightly", false],
    ["agent:main:cronicle:nightly", false],
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

  it("classifies unnamed isolated heartbeat lanes as system-created", () => {
    expect(
      isSystemCreatedSessionRow({
        key: "agent:main:dashboard:00000000-0000-0000-0000-000000000000:heartbeat",
        classification: "heartbeat",
      }),
    ).toBe(true);
  });

  it("keeps an operator-named heartbeat lane discoverable", () => {
    expect(
      isSystemCreatedSessionRow({
        key: "agent:main:main:heartbeat",
        classification: "heartbeat",
        label: "Background watch",
      }),
    ).toBe(false);
  });

  it("leaves non-heartbeat classifications on the provenance path", () => {
    expect(
      isSystemCreatedSessionRow({
        key: "agent:main:main",
        classification: "main",
      }),
    ).toBe(false);
  });
});
