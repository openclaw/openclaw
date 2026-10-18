import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { invalidatePluginRuntimeDiscoveryAfterConfigMutation } from "../plugins/registry-refresh.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runQuickstartForegroundGateway } from "./onboard-quickstart-host.js";

const mocks = vi.hoisted(() => ({ readConfigSnapshot: vi.fn(), invocation: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigSnapshot,
}));
// The child fixture reads real installed metadata; only the executable entry is substituted.
vi.mock("../infra/openclaw-cli-invocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-cli-invocation.js")>()),
  resolveCurrentOpenClawCliInvocation: mocks.invocation,
}));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  waitForGatewayReachable: async () => ({ ok: false }),
}));

afterEach(() => clearPluginMetadataLifecycleCaches());

it.each([false, true])(
  "carries an onboarding install and caller cwd into the first foreground Gateway (pinned caller: %s)",
  async (pinnedCaller) => {
    await withOpenClawTestState(
      { label: "onboarding-plugin-generation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config: OpenClawConfig = {
          gateway: { mode: "local", auth: { mode: "none" } },
          agents: { defaults: { workspace: state.workspaceDir } },
          plugins: { entries: { codex: { enabled: true } } },
        };
        await state.writeConfig(config);
        // The CLI keeps this operation alive from provider selection through browser handoff.
        await withPluginCache(createPluginCache(), async () => {
          const readMetadata = () =>
            resolveConfigWidePluginMetadataSnapshot({
              config,
              env: process.env,
              allowCurrent: false,
            });
          const initial = readMetadata();
          expect(initial.byPluginId.has("codex")).toBe(false);
          const installAndStart = async () => {
            const pluginRoot = state.statePath(
              "npm",
              "projects",
              "codex-fixture",
              "node_modules",
              "@fixture",
              "codex",
            );
            await fs.mkdir(pluginRoot, { recursive: true });
            await fs.writeFile(
              path.join(pluginRoot, "package.json"),
              JSON.stringify({
                name: "@fixture/codex",
                version: "1.0.0",
                openclaw: { extensions: ["./index.cjs"] },
              }),
            );
            await fs.writeFile(
              path.join(pluginRoot, "openclaw.plugin.json"),
              JSON.stringify({
                id: "codex",
                activation: { onAgentHarnesses: ["codex"] },
                configSchema: { type: "object", properties: {}, additionalProperties: false },
              }),
            );
            await fs.writeFile(
              path.join(pluginRoot, "index.cjs"),
              'module.exports = { id: "codex", register() {} };\n',
            );
            // Package acquisition is synthetic; the install ledger and post-install invalidation are real.
            await withPluginLifecycleLease({}, async () => {
              await seedInstalledPluginIndex(
                {
                  codex: {
                    source: "npm",
                    spec: "@fixture/codex@1.0.0",
                    installPath: pluginRoot,
                    resolvedName: "@fixture/codex",
                    resolvedVersion: "1.0.0",
                  },
                },
                { config, env: process.env },
              );
              clearPluginMetadataLifecycleCaches();
              await invalidatePluginRuntimeDiscoveryAfterConfigMutation({});
            });
            expect(withPluginCache(createPluginCache(), readMetadata).byPluginId.has("codex")).toBe(
              true,
            );
            const inventoryPath = state.statePath("child-plugin-inventory.json");
            const packageCwd = process.cwd();
            const callerCwd = state.path("caller-workspace");
            await fs.mkdir(callerCwd);
            const metadataUrl = new URL("../config/io.plugin-metadata.ts", import.meta.url).href;
            const fixture = `
              const { writeFile } = await import("node:fs/promises");
              const { resolveConfigWidePluginMetadataSnapshot } = await import(${JSON.stringify(metadataUrl)});
              const metadata = resolveConfigWidePluginMetadataSnapshot({
                config: ${JSON.stringify(config)}, env: process.env, allowCurrent: false,
              });
              await writeFile(${JSON.stringify(inventoryPath)}, JSON.stringify({
                plugins: [...metadata.byPluginId.keys()], cwd: process.cwd(),
              }));
            `;
            mocks.invocation.mockReturnValue({
              command: process.execPath,
              args: [
                "--import",
                path.join(packageCwd, "scripts/tsx.mjs"),
                "--input-type=module",
                "-e",
                fixture,
              ],
              cwd: packageCwd,
              env: { TSX_TSCONFIG_PATH: path.join(packageCwd, "tsconfig.json") },
            });
            mocks.readConfigSnapshot.mockResolvedValue({ config });
            process.chdir(callerCwd);
            try {
              await runQuickstartForegroundGateway({
                runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
              });
            } finally {
              process.chdir(packageCwd);
            }
            expect(JSON.parse(await fs.readFile(inventoryPath, "utf8"))).toEqual({
              plugins: expect.arrayContaining(["codex"]),
              cwd: callerCwd,
            });
            expect(readMetadata().byPluginId.has("codex")).toBe(!pinnedCaller);
          };
          await (pinnedCaller
            ? withPluginRuntimeGenerationScope({ metadataSnapshot: initial }, installAndStart)
            : installAndStart());
        });
      },
    );
  },
);
