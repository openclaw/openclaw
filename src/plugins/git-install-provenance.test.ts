import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { loadOpenClawPlugins } from "./loader.js";
import { installManagedPlugin } from "./management-mutations.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { buildPluginSnapshotReport } from "./status.js";

afterEach(() => vi.unstubAllEnvs());

it("loads a pinned Git install without an invalid-provenance warning or official authority", async () => {
  await withOpenClawTestState(
    { label: "git-provenance", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const id = "git-provenance-fixture";
      await state.writeConfig({ plugins: { slots: { memory: "none" } } });
      vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
      const source = state.statePath("source");
      await state.writeJson("source/package.json", {
        name: id,
        version: "1.0.0",
        openclaw: { extensions: ["index.cjs"] },
      });
      await state.writeJson("source/openclaw.plugin.json", {
        id,
        configSchema: { type: "object", properties: {} },
        contracts: { tools: [id] },
      });
      await state.writeText(
        "source/index.cjs",
        `module.exports = { id: ${JSON.stringify(id)}, register(api) {
            api.registerTool({
              name: api.id, description: "Git fixture", parameters: { type: "object" },
              async execute() {
                return await api.runtime.hooks.dispatchHookAgentTurn({
                  name: "Git fixture", agentId: "main", sessionKey: "hook:git:1",
                  message: "Synthetic event", externalContentSource: "email", deliver: false,
                });
              },
            });
          } };`,
      );
      const git = async (...args: string[]) => {
        const result = await runCommandWithTimeout(["git", ...args], {
          cwd: source,
          timeoutMs: 10_000,
        });
        expect(result.code, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      await git("init", "--initial-branch=main");
      await git("add", ".");
      await git(
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Synthetic plugin",
      );
      const commit = await git("rev-parse", "HEAD");
      const url = pathToFileURL(source).href;
      const spec = `git:${url}#${commit}`;
      await installManagedPlugin({
        request: { source: "git", spec, mode: "install" },
        env: state.env,
        onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        runtime: { log() {} },
      });
      const records = await readPersistedInstalledPluginIndexInstallRecordsAsync({
        env: state.env,
      });
      const record = expectDefined(records?.[id], "persisted Git install");
      const { config } = await readConfigFileSnapshot();
      const inspected = buildPluginSnapshotReport({ config }).plugins.find(
        (entry) => entry.id === id,
      );
      const dispatchHookAgentTurn = vi.fn();
      const registry = loadOpenClawPlugins({
        config,
        cache: false,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtimeOptions: { hooks: { dispatchHookAgentTurn } },
      });
      try {
        const loaded = registry.plugins.find((entry) => entry.id === id)!;
        expect(loaded.status).toBe("loaded");
        expect(inspected?.trust).toEqual(loaded.trust);
        expect(loaded.trust?.reason).toBe("third-party-git");
        expect(loaded.trustedOfficialInstall).not.toBe(true);
        expect(registry.diagnostics.filter((entry) => entry.pluginId === id)).toEqual([]);
        const tool = registry.tools.find((entry) => entry.pluginId === id)?.factory({});
        if (!tool || Array.isArray(tool)) {
          throw new Error("Expected fixture tool");
        }
        await expect(tool.execute("hook", {})).rejects.toMatchObject({
          code: "PLUGIN_TRUST_REFUSED",
        });
        expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
      } finally {
        await disposePluginRegistryInstances(registry);
      }
      for (const [override, reason] of [
        [{ spec: "not-a-git-spec" }, "provenance-invalid"],
        [{ gitUrl: "https://example.invalid/other.git" }, "provenance-invalid"],
        [{ gitRef: "other" }, "provenance-invalid"],
        [{ gitCommit: "0".repeat(40) }, "provenance-invalid"],
        [{ gitCommit: undefined }, "provenance-invalid"],
        [{ installPath: state.path("other") }, "record-missing"],
      ] satisfies Array<[Partial<PluginInstallRecord>, string]>) {
        const invalid = loadOpenClawPlugins({
          config: {
            ...config,
            plugins: { ...config.plugins, load: { paths: [record.installPath!] } },
          },
          cache: false,
          activate: false,
          installRecords: { [id]: { ...record, ...override } },
        });
        try {
          expect(invalid.plugins.find((entry) => entry.id === id)?.trust?.reason).toBe(reason);
          expect(invalid.diagnostics).toContainEqual(
            expect.objectContaining({
              pluginId: id,
              level: "warn",
              message: expect.stringContaining(`reason=${reason}`),
            }),
          );
        } finally {
          await disposePluginRegistryInstances(invalid);
        }
      }
    },
  );
});
