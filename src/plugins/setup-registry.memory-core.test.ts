// Covers Memory Core setup migration for selected external memory plugins.
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "./setup-registry.js";

describe("Memory Core setup config migration", () => {
  test("moves dreaming from the selected external memory plugin", () => {
    const result = runPluginSetupConfigMigrations({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
          entries: {
            "memory-lancedb": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.changes).toEqual([
      "Moved plugins.entries.memory-lancedb.config.dreaming → memory.extensions.memory-core.dreaming.",
    ]);
    expect(result.config.memory?.extensions?.["memory-core"]).toEqual({
      dreaming: {
        enabled: true,
      },
    });
    expect(result.config.plugins?.entries?.["memory-lancedb"]?.config).toEqual({});
  });
});
