import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registry: {
    diagnostics: [],
    plugins: [] as unknown[],
  },
}));

vi.mock("../manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => mocks.registry,
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

import {
  resolvePluginRuntimeRecord,
  resolvePluginRuntimeRecordByEntryBaseNames,
} from "./runtime-plugin-boundary.js";

const tempDirs: string[] = [];

function makeRuntimePluginFixture(pluginId: string) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-boundary-"));
  tempDirs.push(rootDir);
  const source = path.join(rootDir, "index.js");
  fs.writeFileSync(source, "export default {};\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "light-runtime-api.js"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "runtime-api.js"), "export {};\n", "utf8");
  return {
    id: pluginId,
    origin: "global",
    rootDir,
    source,
  };
}

function expectHealthyRuntimeRecord(plugin: ReturnType<typeof makeRuntimePluginFixture>) {
  expect(resolvePluginRuntimeRecord(plugin.id)).toEqual({
    origin: "global",
    rootDir: plugin.rootDir,
    source: plugin.source,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  mocks.registry.plugins = [];
});

describe("runtime plugin boundary manifest lookup", () => {
  it("skips unreadable manifest rows when resolving a runtime record by plugin id", () => {
    const healthyPlugin = makeRuntimePluginFixture("healthy-runtime");
    const poisonedPlugin = Object.defineProperty({}, "id", {
      get() {
        throw new Error("runtime boundary manifest id exploded");
      },
    });

    mocks.registry.plugins = [poisonedPlugin, healthyPlugin];

    expectHealthyRuntimeRecord(healthyPlugin);
  });

  it("skips unreadable manifest rows when resolving by runtime entry base names", () => {
    const healthyPlugin = makeRuntimePluginFixture("healthy-web-channel-runtime");
    const poisonedPlugin = {
      id: "poisoned-runtime",
      rootDir: healthyPlugin.rootDir,
      get source() {
        throw new Error("runtime boundary manifest source exploded");
      },
    };

    mocks.registry.plugins = [poisonedPlugin, healthyPlugin];

    expect(
      resolvePluginRuntimeRecordByEntryBaseNames(["light-runtime-api", "runtime-api"]),
    ).toEqual({
      origin: "global",
      rootDir: healthyPlugin.rootDir,
      source: healthyPlugin.source,
    });
  });
});
