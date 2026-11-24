import { expect, it } from "vitest";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { createSnapshot } from "./mutate.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";

// Offline writes, Gateway config.patch writes and Doctor repair share this preparation.
const prepare = (sourceConfig: OpenClawConfig, nextConfig: OpenClawConfig, paths: string[][]) =>
  prepareConfigWriteTopology({
    snapshot: { ...createSnapshot({ sourceConfig }), authoredConfig: sourceConfig },
    nextConfig,
    options: { explicitSetPaths: paths },
    unsetPaths: [],
    env: {},
  });

it("refuses a plugins write, even an equal value, while built-in-era Workshop policy is ignored", async () => {
  const legacy: OpenClawConfig = { plugins: { entries: { "skill-workshop": { enabled: false } } } };
  const path = [["plugins", "entries", "skill-workshop", "enabled"]];

  await expect(prepare(legacy, structuredClone(legacy), path)).rejects.toThrow("doctor --fix");
  const migrated = { ...legacy, meta: { migrations: { skillWorkshopPlugin: true as const } } };
  await expect(prepare(migrated, structuredClone(migrated), path)).resolves.toBeDefined();
});
