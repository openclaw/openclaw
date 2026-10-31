import { expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";

it("removes retired path flags without dropping provider or install-exec records", () => {
  const raw = {
    secrets: {
      providers: {
        configured: {
          source: "exec",
          command: "/usr/bin/printf",
          allowInsecurePath: false,
          allowSymlinkCommand: undefined,
        },
        empty: { allowInsecurePath: false },
        malformed: [],
        absent: null,
      },
    },
    security: {
      installPolicy: {
        enabled: false,
        exec: { allowInsecurePath: undefined, allowSymlinkCommand: false },
      },
    },
  };
  const expected = {
    secrets: {
      providers: {
        configured: { source: "exec", command: "/usr/bin/printf" },
        empty: {},
        malformed: [],
        absent: null,
      },
    },
    security: { installPolicy: { enabled: false, exec: {} } },
  };
  const apply = () => {
    const changes: string[] = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME) {
      migration.apply(raw, changes);
    }
    return changes;
  };
  expect(apply()).toEqual([
    "Applied tier-eval tranche retirements; current settings and built-in defaults now apply.",
  ]);
  expect(raw).toStrictEqual(expected);
  expect(apply()).toEqual([]);
  expect(raw).toStrictEqual(expected);
});
