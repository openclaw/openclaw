import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createColdPluginFixture,
  createColdPluginConfig,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  logs: [] as string[],
}));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

// mock-isolation: Cold-route fixtures keep config and plugin discovery independent of operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testState.config,
  loadConfig: () => testState.config,
  captureRuntimeConfigAsyncReader: () => async () => testState.config,
}));

// mock-isolation: Capture cold-route output without process exit or real output streams.
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    ...createNonExitingRuntimeEnv(),
    log: (...args: unknown[]) => testState.logs.push(args.map(String).join(" ")),
  },
  writeRuntimeJson: vi.fn(),
}));

for (const module of [
  "./plugins-cli.js",
  "../plugins/loader-module-runtime.js",
  "../plugins/capability-consent.js",
]) {
  vi.doMock(module, () => {
    throw new Error(`metadata inventory must not load ${module}`);
  });
}
const { tryRouteCli } = await import("./route.js");
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterAll(() => vi.unstubAllEnvs());

it("renders the default list from metadata without loading plugin modules", async () => {
  const tempRoot = tempDirs.make("openclaw-plugins-list-route-");
  const pluginRoot = tempDirs.make("route-demo-", tempRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "route-demo",
    packageVersion: "4.2.0",
    manifest: { name: "Route Demo", description: "Prepared inventory metadata" },
  });
  const bundledRoot = tempDirs.make("bundled-", tempRoot);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  testState.config = createColdPluginConfig(pluginRoot, "route-demo");

  await expect(tryRouteCli(["node", "openclaw", "plugins", "list"])).resolves.toBe(true);

  const output = testState.logs.join("\n");
  for (const text of ["Route Demo", "route-demo", "Prepared inventory metadata", "4.2.0"]) {
    expect(output).toContain(text);
  }
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
});
