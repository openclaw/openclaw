import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveNodeRuntimeExecutable } from "../../../infra/node-runtime-executable.js";
import { runPluginRegisterSyncInRegistry } from "../../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../../plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../../../plugins/runtime.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { setPluginRuntimeLoadContext } from "../../../plugins/runtime/load-context.js";
import type { OpenClawPluginDefinition } from "../../../plugins/types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../../test-utils/bundled-plugin-public-surface.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import type { NativePluginSpawnTestOptions } from "./subagent-spawn.production-boundary.test-support.js";

export async function installSpawnAccessCodex(
  bound: Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>,
  outcome: string,
) {
  const root = path.dirname(bound.storePath);
  fs.mkdirSync(root, { recursive: true });
  const logPath = path.join(root, "access-codex-messages.jsonl");
  const pluginSource = resolveBundledPluginPublicModulePath({
    pluginId: "codex",
    artifactBasename: "index.js",
  });
  const pluginRoot = path.dirname(pluginSource);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  // Keep proof parameters in the launcher: private native probes deliberately
  // rebuild app-server arguments and do not preserve arbitrary CLI suffixes.
  const launcher = path.join(root, "access-codex-launcher.mjs");
  const fixtureUrl = new URL(
    "../../../../test/e2e/qa-lab/runtime/codex-access-app-server.fixture.mjs",
    import.meta.url,
  ).href;
  fs.writeFileSync(
    launcher,
    `import { runSpawnAccessFixture } from ${JSON.stringify(fixtureUrl)};
` +
      `runSpawnAccessFixture(${JSON.stringify({
        requestLog: logPath,
        outcome,
        version: manifest.dependencies["@openai/codex"],
      })});
`,
  );
  const pluginConfig = {
    sessionCatalog: { enabled: false },
    appServer: {
      command: expectDefined(resolveNodeRuntimeExecutable(), "Node runtime executable"),
      args: [launcher, "app-server"],
      transport: "stdio",
      homeScope: "agent",
    },
  };
  bound.cfg.plugins = { entries: { codex: { enabled: true, config: pluginConfig } } };
  expectDefined(
    bound.cfg.agents?.defaults?.models?.["openai/gpt-6.1-sol"],
    "configured child model",
  ).agentRuntime = { id: "codex" };
  setRuntimeConfigSnapshot(bound.cfg);
  const builder = createRuntimeTestRegistry(createPluginRuntime());
  const record = createPluginRecord({
    id: "codex",
    source: pluginSource,
    rootDir: pluginRoot,
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  const api = builder.createApi(record, { config: bound.cfg, pluginConfig });
  const plugin = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "codex",
    artifactBasename: "index.js",
  });
  runPluginRegisterSyncInRegistry(
    expectDefined(plugin.default.register, "Codex public registration"),
    api,
    builder.registry,
    "codex",
  );
  expect(builder.registry.agentHarnesses.map(({ harness }) => harness.id)).toEqual(["codex"]);
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: bound.cfg,
    config: bound.cfg,
    activationSourceConfig: bound.cfg,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  getPreparedModelRuntimeMocks().loadAgentRuntimePluginRegistryHandle.mockReturnValue(
    builder.registry,
  );
  onTestFinished(async () => {
    await disposePluginRegistryInstances(builder.registry);
  });
  return {
    readMessages: (): Array<{ method?: string; params?: Record<string, unknown> }> =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
