import { afterEach, expect, it, vi } from "vitest";
import * as pluginModuleLoader from "../../../plugins/plugin-module-loader-cache.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "implicit single agent", config: {} },
  { name: "explicit single agent", config: { agents: { entries: { main: {} } } } },
  {
    name: "disabled plugins",
    config: { agents: { entries: { main: {}, helper: {} } }, plugins: { enabled: false } },
  },
  {
    name: "malformed binding owner",
    config: {
      agents: { entries: { main: {}, helper: {} } },
      bindings: [{ agentId: "", match: { channel: "discord" } }],
    },
  },
])("migrates $name without loading the channel ownership runtime", ({ config }) => {
  const load = pluginModuleLoader.getCachedPluginModuleLoader;
  vi.spyOn(pluginModuleLoader, "getCachedPluginModuleLoader").mockImplementation((options) => {
    if (/legacy-config-binding-repair\.runtime\.[jt]s$/u.test(options.modulePath)) {
      throw new Error("Loaded channel ownership runtime for an inapplicable repair");
    }
    return load(options);
  });
  const source = { ...config, gateway: { bind: "localhost" } };

  const migrated = applyLegacyDoctorMigrations(source, { sourceConfigBeforeMigrations: source });

  expect(migrated.next?.gateway).toMatchObject({ bind: "loopback" });
  expect(source.gateway.bind).toBe("localhost");
});
