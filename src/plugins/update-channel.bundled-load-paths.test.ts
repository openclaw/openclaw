import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { collectPluginReloadTargets } from "../cli/update-cli/update-command-plugin-records.js";
import { maybeRepairBundledPluginLoadPaths } from "../commands/doctor/shared/bundled-plugin-load-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";
import { writeCohortPackage } from "./update-cohort.test-support.js";

const bundledSources = vi.hoisted(() => new Map<string, { pluginId: string; localPath: string }>());
vi.mock("./bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-sources.js")>()),
  resolveBundledPluginSources: () => bundledSources,
}));

afterEach(() => vi.unstubAllGlobals());

describe("plugin sync bundled load paths", () => {
  it.each([
    { channel: "dev", source: "path" },
    { channel: "stable", source: "path" },
    { channel: "dev", source: "npm" },
    { channel: "dev", source: "previous" },
    { channel: "stable", source: "previous" },
    { channel: "dev", source: "linked" },
    { channel: "stable", source: "npm" },
  ] as const)(
    "$channel sync of a $source install leaves the shape Doctor keeps",
    async ({ channel, source }) => {
      await withOpenClawTestState({ label: "bundled-load-paths" }, async (state) => {
        const current = state.path("openclaw");
        const previous = state.path("previous-openclaw");
        for (const root of [current, previous]) {
          writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
          writeCohortPackage(path.join(root, "dist", "extensions", "brave"), "brave");
        }
        vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(`${current}/`).href);
        const bundledPath = path.join(current, "dist", "extensions", "brave");
        const previousPath = path.join(previous, "dist", "extensions", "brave");
        bundledSources.set("brave", { pluginId: "brave", localPath: bundledPath });
        const config: OpenClawConfig = {
          plugins: {
            load: {
              paths: [source === "linked" ? previousPath : state.path("linked-plugin")],
            },
            entries: { brave: { enabled: true, config: { marker: "keep" } } },
            allow: ["brave"],
            installs: {
              brave:
                source !== "npm"
                  ? {
                      source: "path",
                      sourcePath: source === "path" ? bundledPath : previousPath,
                      installPath: source === "path" ? bundledPath : previousPath,
                      version: "2026.11.10",
                    }
                  : { source, spec: "@openclaw/brave", installPath: state.path("npm", "brave") },
            },
          },
        };

        const result = await syncPluginsForUpdateChannel({ channel, config, env: state.env });

        const retained = source === "linked" || (channel === "stable" && source !== "previous");
        expect(result.changed).toBe(!retained);
        expect(result.config.plugins?.load).toEqual(config.plugins?.load);
        expect(result.config.plugins?.entries).toEqual({
          brave: { enabled: true, config: { marker: "keep" } },
        });
        expect(result.config.plugins?.allow).toEqual(["brave"]);
        expect(result.config.plugins?.installs?.brave).toEqual(
          retained ? config.plugins?.installs?.brave : undefined,
        );
        expect(
          collectPluginReloadTargets(
            config.plugins?.installs ?? {},
            result.config.plugins?.installs ?? {},
          ),
        ).toEqual([]);
        if (!retained) {
          const index = withPluginCache(createPluginCache(), () =>
            loadInstalledPluginIndex({
              config: result.config,
              installRecords: result.config.plugins?.installs ?? {},
              env: state.env,
            }),
          );
          expect(
            createInstalledPluginOwnershipResolver(index, state.env).resolveReload("brave"),
          ).toEqual({ ok: true, value: { kind: "discovered", pluginIds: ["brave"] } });
        }
        if (source !== "linked") {
          expect(maybeRepairBundledPluginLoadPaths(result.config, state.env).changes).toEqual([]);
        }
      });
    },
  );
});
