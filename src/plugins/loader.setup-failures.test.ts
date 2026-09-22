import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { disposePluginRegistryInstances } from "./runtime.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(
  ["setup", "runtime", "setter"].flatMap((stage) =>
    ['new Error("setup fixture failed")', "undefined", "null", "false", "0", '""'].map(
      (failure) => ({ stage, failure }),
    ),
  ),
)("retires a failed $stage owner after throwing $failure", async ({ stage, failure }) => {
  useNoBundledPlugins();
  const id = "failed-channel-setup";
  const broken = writePlugin({
    id,
    filename: "index.cjs",
    body: `module.exports = { id: "${id}", kind: "bundled-channel-entry",
      loadChannelPlugin() { throw ${failure}; } };`,
  });
  writePluginMetadata({
    dir: broken.dir,
    id,
    channels: [id],
    packageJson: { openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup.cjs" } },
  });
  fs.writeFileSync(
    path.join(broken.dir, "setup.cjs"),
    `module.exports = { kind: "bundled-channel-setup-entry",
      loadSetupPlugin() {
        ${stage === "setup" ? `throw ${failure};` : `return { id: "${id}" };`}
      },
      ${stage === "setter" ? `setChannelRuntime() { throw ${failure}; }` : ""}
    };`,
  );
  const healthy = writePlugin({ id: "healthy-setup-sibling", registration: "" });
  const registry = loadPluginRegistryHandle({
    cache: false,
    channelPluginLoadIntent: "setup",
    config: {
      plugins: {
        allow: [id, healthy.id],
        load: { paths: [broken.dir, healthy.dir] },
        slots: { memory: "none" },
      },
    },
  });
  try {
    const failed = registry.plugins.find((record) => record.id === id)!;
    expect(failed).toMatchObject({ status: "error", failurePhase: "load" });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: id,
        code: "channel-setup-failure",
        message: expect.stringContaining(
          stage === "setup"
            ? "failed to load setup entry"
            : stage === "runtime"
              ? "failed to load setup-runtime channel entry"
              : "failed to apply setup channel runtime",
        ),
      }),
    );
    const instance = getPluginInstance(failed)!;
    expect(instance.acceptingCalls).toBe(false);
    expect(instance.disposing).toBe(true);
    expect(() => instance.run(() => "failed owner is still callable")).toThrow();
    const sibling = registry.plugins.find((record) => record.id === healthy.id)!;
    expect(sibling.status).toBe("loaded");
    expect(getPluginInstance(sibling)!.run(() => "healthy")).toBe("healthy");
    await instance.dispose();
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
