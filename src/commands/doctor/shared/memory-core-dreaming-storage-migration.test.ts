import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { maybeMigrateMemoryCoreDreamingStorage } from "./memory-core-dreaming-storage-migration.js";

function configWithStorage(storage: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "memory-core": {
          enabled: true,
          config: { dreaming: { storage } },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("maybeMigrateMemoryCoreDreamingStorage (#70407)", () => {
  it.each([["both"], ["inline"], ["separate"]])(
    'migrates legacy string storage "%s" to the new object shape',
    (mode) => {
      const result = maybeMigrateMemoryCoreDreamingStorage(configWithStorage(mode));

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toContain("memory-core");
      expect(result.changes[0]).toContain(mode);
      const migrated = (result.config as unknown as Record<string, any>).plugins.entries[
        "memory-core"
      ].config.dreaming.storage;
      expect(migrated).toEqual({ mode, separateReports: false });
    },
  );

  it("is a no-op when storage is already the new object shape", () => {
    const cfg = configWithStorage({ mode: "both", separateReports: true });
    const result = maybeMigrateMemoryCoreDreamingStorage(cfg);
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("is a no-op for unknown legacy string values (let validation surface them)", () => {
    const cfg = configWithStorage("legacy-mode-not-in-enum");
    const result = maybeMigrateMemoryCoreDreamingStorage(cfg);
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("is a no-op when memory-core has no dreaming.storage at all", () => {
    const cfg: OpenClawConfig = {
      plugins: { entries: { "memory-core": { enabled: true, config: { dreaming: {} } } } },
    } as unknown as OpenClawConfig;
    const result = maybeMigrateMemoryCoreDreamingStorage(cfg);
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("is a no-op when memory-core is not configured at all", () => {
    const cfg: OpenClawConfig = { plugins: { entries: {} } } as unknown as OpenClawConfig;
    const result = maybeMigrateMemoryCoreDreamingStorage(cfg);
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("does not mutate the input config", () => {
    const cfg = configWithStorage("both");
    const snapshot = JSON.parse(JSON.stringify(cfg));
    maybeMigrateMemoryCoreDreamingStorage(cfg);
    expect(cfg).toEqual(snapshot);
  });

  it("produces a config that passes validateConfigObjectWithPlugins (end-to-end unblock)", () => {
    const cfg = configWithStorage("both");
    // Sanity check: pre-migration config is invalid.
    const before = validateConfigObjectWithPlugins(cfg);
    if (before.ok) {
      throw new Error("expected pre-migration config to fail validation");
    }
    expect(
      before.issues.some((issue) =>
        issue.path.startsWith("plugins.entries.memory-core.config.dreaming.storage"),
      ),
    ).toBe(true);

    const result = maybeMigrateMemoryCoreDreamingStorage(cfg);
    const after = validateConfigObjectWithPlugins(result.config);
    if (after.ok) {
      // No issues at all — definitely no remaining storage issues.
      return;
    }
    const remainingStorageIssues = after.issues.filter((issue) =>
      issue.path.startsWith("plugins.entries.memory-core.config.dreaming.storage"),
    );
    expect(remainingStorageIssues).toEqual([]);
  });
});
