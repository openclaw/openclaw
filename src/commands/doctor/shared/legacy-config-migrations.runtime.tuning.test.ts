import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

describe("retired tuning notices", () => {
  it.each([
    {
      diagnostics: { enabled: true, memoryPressureSnapshot: false },
      expectedChanges: [
        "Removed retired runtime tuning knobs: diagnostics.memoryPressureSnapshot; built-in defaults now apply.",
      ],
    },
    { diagnostics: { enabled: true }, expectedChanges: [] },
  ])("names only removed keys: $diagnostics", ({ diagnostics, expectedChanges }) => {
    const raw = { diagnostics: { ...diagnostics } };
    const changes: string[] = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS) {
      migration.apply(raw, changes);
    }
    expect(raw).toEqual({ diagnostics: { enabled: true } });
    expect(changes).toEqual(expectedChanges);
  });

  it("keeps removed wildcard paths on one notice line", () => {
    const raw = {
      agents: {
        defaults: {
          cliBackends: { "local\nlegacy": { reliability: { outputLimits: {} } } },
        },
      },
    };
    const changes: string[] = [];
    const migration = expectDefined(
      LEGACY_CONFIG_MIGRATIONS.find(({ id }) => id === "runtime.tuning-knobs-purge"),
      "tuning-knob migration",
    );
    migration.apply(raw, changes);
    expect(changes).toEqual([
      "Removed retired runtime tuning knobs: agents.defaults.cliBackends.local\\nlegacy.reliability.outputLimits; built-in defaults now apply.",
    ]);
  });
});
