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

it("keeps module ownership work independent of captured dependency count", () => {
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
    const sourceRoot = dependencyCount
      ? path.join(root, "node_modules", `fixture-${dependencyCount - 1}`)
      : root;
    const expectedRoot = artifact.sourceAliases[sourceRoot];
    if (!expectedRoot) {
      throw new Error("Captured package root is missing");
    }
    const captured = path.join(expectedRoot, "index.js");
    expect(fs.readFileSync(captured, "utf8")).toBe("exports.value = 1;");
    const observed = (() => {
      const relative = vi.spyOn(path, "relative");
      const startsWith = vi.spyOn(String.prototype, "startsWith");
      try {
        const foreignAdditions = artifact.prepareModule(foreign);
        const foreignComparisons = relative.mock.calls.length + startsWith.mock.calls.length;
        const capturedRoot = artifact.moduleRoot(captured);
        const capturedAdditions = artifact.prepareModule(captured);
        const capturedComparisons =
          relative.mock.calls.length + startsWith.mock.calls.length - foreignComparisons;
        return {
          foreignAdditions,
          foreignComparisons,
          capturedRoot,
          capturedAdditions,
          capturedComparisons,
        };
      } finally {
        relative.mockRestore();
        startsWith.mockRestore();
      }
    })();
    expect(observed.foreignAdditions).toEqual([]);
    expect(observed.capturedRoot).toBe(expectedRoot);
    expect(observed.capturedAdditions).toEqual([]);
    return observed;
  };
  const empty = countPathComparisons(0);
  const populated = countPathComparisons(24);
  // Compare work growth instead of wall time: native resolver hooks run this per import.
  expect(populated.foreignComparisons).toBeLessThanOrEqual(empty.foreignComparisons + 1);
  expect(populated.capturedComparisons).toBeLessThanOrEqual(empty.capturedComparisons + 1);
  expect(fs.readFileSync(foreign, "utf8")).toBe("export const value = 1;");
});
