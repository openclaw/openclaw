import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maybeRepairBundledPluginLoadPaths } from "../commands/doctor/shared/bundled-plugin-load-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";

const bundledSources = vi.hoisted(() => new Map<string, { pluginId: string; localPath: string }>());
vi.mock("./bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-sources.js")>()),
  resolveBundledPluginSources: () => bundledSources,
}));

describe("plugin sync bundled load paths", () => {
  it.each([
    { channel: "dev", source: "path" },
    { channel: "stable", source: "path" },
    { channel: "dev", source: "npm" },
  ] as const)(
    "$channel sync of a $source install leaves the shape Doctor keeps",
    async ({ channel, source }) => {
      await withOpenClawTestState({ label: "bundled-load-paths" }, async (state) => {
        const bundledPath = path.join(state.root, "openclaw", "dist", "extensions", "brave");
        bundledSources.set("brave", { pluginId: "brave", localPath: bundledPath });
        const config: OpenClawConfig = {
          plugins: {
            load: { paths: [path.join(state.root, "linked-plugin")] },
            installs: {
              brave:
                source === "path"
                  ? { source, sourcePath: bundledPath, installPath: bundledPath }
                  : { source, spec: "@openclaw/brave", installPath: state.path("npm", "brave") },
            },
          },
        };

        const result = await syncPluginsForUpdateChannel({ channel, config, env: state.env });

        // A switch to the bundled copy is a real change; an already bundled install is not.
        expect(result.changed).toBe(source === "npm");
        expect(result.config.plugins?.load).toEqual(config.plugins?.load);
        expect(result.config.plugins?.installs?.brave).toMatchObject({
          source: "path",
          sourcePath: bundledPath,
          installPath: bundledPath,
        });
        expect(maybeRepairBundledPluginLoadPaths(result.config, state.env).changes).toEqual([]);
      });
    },
  );
});
