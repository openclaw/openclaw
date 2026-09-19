import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  inspectPluginRegistryMock,
  pluginsCliRuntimeLogs,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  runPluginsCommand,
} from "./plugins-cli-test-helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("plugins registry", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it.each([
    { directory: "p-home", expectedRoot: "$OPENCLAW_HOME" },
    { directory: "p-home-other", expectedRoot: path.resolve(path.sep, "tmp", "p-home-other") },
  ])("preserves differing registry source paths for $directory", async (testCase) => {
    const homeDir = path.resolve(path.sep, "tmp", "p-home");
    const sourceDir = path.resolve(path.sep, "tmp", testCase.directory);
    const differences = [
      {
        pluginId: "source-probe",
        changed: ["source"],
        persistedSource: path.join(sourceDir, "old.js"),
        derivedSource: path.join(sourceDir, "new.js"),
      },
    ];
    inspectPluginRegistryMock.mockResolvedValue({
      state: "stale",
      refreshReasons: ["source-changed"],
      differences,
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "registry"]);
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(
        `persisted ${path.join(testCase.expectedRoot, "old.js")}; derived ${path.join(testCase.expectedRoot, "new.js")}`,
      );
      pluginsCliRuntimeLogs.length = 0;
      await runPluginsCommand(["plugins", "registry", "--json"]);
      expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({ differences });
    });
  });

  it("serializes registry rebuilds with other plugin lifecycle mutations", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const entries: number[] = [];
    refreshPluginRegistryMock.mockImplementation(async () => {
      const entry = entries.length + 1;
      entries.push(entry);
      if (entry === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return { plugins: [] };
    });

    const first = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await firstEntered.promise;
    const second = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(entries).toEqual([1]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(entries).toEqual([1, 2]);
  });
});
