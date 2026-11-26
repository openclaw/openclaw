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
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { withOpenClawTestState as withTestState } from "../test-utils/openclaw-test-state.js";
import { runQuickstartForegroundGateway } from "./onboard-quickstart-host.js";

const mocks = vi.hoisted(() => ({ readConfigSnapshot: vi.fn(), invocation: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigSnapshot,
}));
vi.mock("../infra/openclaw-cli-invocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-cli-invocation.js")>()),
  resolveCurrentOpenClawCliInvocation: mocks.invocation,
}));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  waitForGatewayReachable: async () => ({ ok: false }),
}));

afterEach(() => clearPluginMetadataLifecycleCaches());

it.each([false, true])("fresh Gateway metadata/cwd (pinned caller=%s)", (pinnedCaller) =>
  withTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
    const config: OpenClawConfig = {
      gateway: { mode: "local", auth: { mode: "none" } },
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { entries: { codex: { enabled: true } } },
    };
    await state.writeConfig(config);
    await withPluginCache(createPluginCache(), async () => {
      const readMetadata = () =>
        resolveConfigWidePluginMetadataSnapshot({ config, allowCurrent: false });
      const initial = readMetadata();
      expect(initial.byPluginId.has("codex")).toBe(false);
      const installAndStart = async () => {
        await withPluginLifecycleLease({}, async () => {
          await seedInstalledPluginIndex(
            {
              codex: {
                source: "npm",
                installPath: writeManagedNpmPlugin({
                  stateDir: state.stateDir,
                  packageName: "@fixture/codex",
                  pluginId: "codex",
                  version: "1.0.0",
                }),
              },
            },
            { config, env: process.env },
          );
          clearPluginMetadataLifecycleCaches();
          await invalidatePluginRuntimeDiscoveryAfterConfigMutation({});
        });
        const inventoryPath = state.statePath("child-plugin-inventory.json");
        const packageCwd = process.cwd();
        const tsxLoader = path.join(packageCwd, "scripts/tsx.mjs");
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
          args: ["--import", tsxLoader, "--input-type=module", "-e", fixture],
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
  }),
);
