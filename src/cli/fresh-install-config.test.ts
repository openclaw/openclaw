import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { isUnconfiguredConfigSource, shouldStartLocalOnboarding } from "./fresh-install-config.js";

// Shape captured from a real first run interrupted with Ctrl-C at the Quick start prompt.
const interruptedFirstRun = {
  wizard: { securityAcknowledgedAt: "2026-11-02T22:11:29.390Z" },
  plugins: {
    entries: {
      anthropic: { config: { sessionCatalog: { enabled: false } } },
      codex: { config: { sessionCatalog: { enabled: false } } },
    },
  },
  meta: { lastTouchedVersion: "2026.10.9" },
};

describe("isUnconfiguredConfigSource", () => {
  it("still treats a first run interrupted after its first config write as unconfigured", () => {
    expect(isUnconfiguredConfigSource(interruptedFirstRun)).toBe(true);
  });

  it.each([
    ["an enabled plugin", { entries: { codex: { enabled: true } } }],
    [
      "more plugin config",
      { entries: { codex: { config: { sessionCatalog: { enabled: false }, extra: 1 } } } },
    ],
    [
      "an unknown plugin",
      { entries: { other: { config: { sessionCatalog: { enabled: false } } } } },
    ],
    ["another plugins key", { allow: ["codex"], entries: {} }],
  ])("treats %s as authored config", (_name, plugins) => {
    expect(isUnconfiguredConfigSource({ ...interruptedFirstRun, plugins })).toBe(false);
  });
});

describe("shouldStartLocalOnboarding", () => {
  it("resumes onboarding when only migrations added an agent roster", async () => {
    const migrated = {
      ...interruptedFirstRun,
      agents: { entries: { main: {} } },
    } as unknown as ConfigFileSnapshot["sourceConfig"];
    await expect(
      shouldStartLocalOnboarding({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        sourceConfig: migrated,
        sourceConfigBeforeMigrations: interruptedFirstRun as unknown as typeof migrated,
      }),
    ).resolves.toBe(true);
  });
});
