import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const artifact of artifacts.splice(0)) {
    artifact.dispose();
  }
});

it("keeps unrelated module preparation independent of captured dependency count", () => {
  const fixture = temp.make("plugin-foreign-ownership-");
  const foreign = path.join(fixture, "foreign.mjs");
  fs.writeFileSync(foreign, "export const value = 1;");
  const countPathComparisons = (dependencyCount: number) => {
    const root = path.join(fixture, `plugin-${dependencyCount}`);
    fs.mkdirSync(root);
    const dependencies: Record<string, string> = {};
    for (let index = 0; index < dependencyCount; index++) {
      const name = `fixture-${index}`;
      dependencies[name] = "1.0.0";
      const dependency = path.join(root, "node_modules", name);
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name }));
      fs.writeFileSync(path.join(dependency, "index.js"), "exports.value = 1;");
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies }));
    fs.writeFileSync(path.join(root, "index.js"), "exports.value = 1;");
    const artifact = capturePluginGenerationArtifact(root);
    artifacts.push(artifact);
    const relative = vi.spyOn(path, "relative");
    const startsWith = vi.spyOn(String.prototype, "startsWith");
    const additions = artifact.prepareModule(foreign);
    const comparisons = relative.mock.calls.length + startsWith.mock.calls.length;
    relative.mockRestore();
    startsWith.mockRestore();
    expect(additions).toEqual([]);
    return comparisons;
  };
  const empty = countPathComparisons(0);
  const populated = countPathComparisons(24);
  // Compare work growth instead of wall time: native resolver hooks run this per import.
  expect(populated).toBeLessThanOrEqual(empty + 1);
  expect(fs.readFileSync(foreign, "utf8")).toBe("export const value = 1;");
});
