// Covers Tencent setup config migration registration in the plugin setup registry.
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "./setup-registry.js";

describe("Tencent setup config migration", () => {
  test("repairs TokenHub model defaults through setup registry", () => {
    const result = runPluginSetupConfigMigrations({
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
      config: {
        agents: {
          defaults: {
            model: { primary: "tencent-tokenhub/hy3-preview" },
            models: {
              "tencent-tokenhub/hy3-preview": {},
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.changes).toEqual([
      "Updated Tencent TokenHub agent model defaults to include tencent-tokenhub/hy3 and tencent-tokenhub/hy3-preview.",
      "Changed Tencent TokenHub primary default from tencent-tokenhub/hy3-preview to tencent-tokenhub/hy3.",
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "tencent-tokenhub/hy3",
    });
    expect(Object.keys(result.config.agents?.defaults?.models ?? {}).toSorted()).toEqual([
      "tencent-tokenhub/hy3",
      "tencent-tokenhub/hy3-preview",
    ]);
  });
});
