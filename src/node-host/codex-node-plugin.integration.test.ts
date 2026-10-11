import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  ensureNodeHostPluginRegistry,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import { resetNodeHostPluginRegistry } from "./plugin-node-host.test-support.js";

afterEach(() => {
  resetNodeHostPluginRegistry();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});

describe("Codex node command availability", () => {
  it.each(["missing", "disabled", "denied", "enabled"] as const)(
    "advertises the real plugin only when installed and enabled (%s)",
    async (state) => {
      await withTempDir("openclaw-codex-node-", async (home) => {
        vi.stubEnv("HOME", home);
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "openclaw.json"));
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
        const config: OpenClawConfig = {
          plugins: {
            allow: ["codex"],
            ...(state === "missing" ? {} : { load: { paths: [path.resolve("extensions/codex")] } }),
            ...(state === "denied" ? { deny: ["codex"] } : {}),
            entries: { codex: { enabled: state !== "disabled" } },
          },
        };
        await ensureNodeHostPluginRegistry({
          config,
          env: process.env,
          onlyPluginIds: ["codex"],
        });
        const manifest = listRegisteredNodeHostCapsAndCommands({ config, env: process.env });
        expect(manifest.commands.includes("codex.exec-server.stdio.v1")).toBe(state === "enabled");
        expect(manifest.caps.includes("codex.exec-server")).toBe(state === "enabled");
      });
    },
  );
});
