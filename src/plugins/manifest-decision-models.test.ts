import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("discovers only decision models owned by the manifest without executing its runtime", () => {
  const root = tempDirs.make("manifest-decision-models-");
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        { provider: " fixture ", id: " fast ", name: " Fast decisions " },
        { provider: "fixture", id: "fast", name: "Duplicate" },
        { provider: "other", id: "foreign", name: "Unowned" },
        { provider: "fixture", id: "missing-name" },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(result.manifest.decisionModels).toEqual([
    { provider: "fixture", id: "fast", name: "Fast decisions" },
  ]);
  expect(result.manifest.providers ?? []).toEqual([]);
});
