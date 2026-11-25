import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { maybeRepairInvalidPluginConfig } from "./invalid-plugin-config.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";

afterEach(() => vi.unstubAllEnvs());

it.each([true, false])(
  "preserves retired AgentsAPI ownership through Doctor repair when enabled=%s",
  (enabled) => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    const config: OpenClawConfig = {
      plugins: {
        allow: ["agentsapi"],
        entries: {
          agentsapi: {
            enabled,
            config: { environment: "self_hosted", executorController: "original-controller" },
          },
        },
      },
    };
    const before = structuredClone(config);
    withPluginCache(createPluginCache(), () => {
      expect(findDoctorLegacyConfigIssues(config)).toContainEqual(
        expect.objectContaining({
          path: "plugins.entries.agentsapi.config.executorController",
          message: expect.stringContaining("previous OpenClaw version"),
        }),
      );
      if (enabled) {
        expect(validateConfigObjectWithPlugins(config).ok).toBe(false);
      }
      expect(maybeRepairInvalidPluginConfig(config)).toEqual({ config: before, changes: [] });
    });
    expect(config).toEqual(before);
  },
);
