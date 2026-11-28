import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as activationCheck from "../../plugin-sdk/facade-activation-check.runtime.js";
import * as facadeRuntime from "../../plugin-sdk/facade-runtime.js";
import { writeFacadeFiles } from "../../plugin-sdk/facade-runtime.test-support.js";
import { captureEnv } from "../../test-utils/env.js";

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config?: unknown }) => ({
    config: config ?? {},
    autoEnabledReasons: {},
  }),
}));

const originalEnv = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR", "OPENCLAW_STATE_DIR"]);
const tempDirs = createTempDirTracker();

function createInstalledRuntimePluginDir(pluginId: string, marker: string) {
  const bundledDir = tempDirs.make(`openclaw-runtime-contract-bundled-${pluginId}-`);
  const stateDir = tempDirs.make(`openclaw-runtime-contract-state-${pluginId}-`);
  const pluginRoot = path.join(stateDir, "extensions", pluginId);
  writeFacadeFiles(pluginRoot, {
    "runtime-api.js": `export const marker = ${JSON.stringify(marker)};\n`,
    "package.json": {
      name: `@openclaw/${pluginId}`,
      version: "0.0.0",
      type: "module",
      openclaw: { extensions: ["./runtime-api.js"], channel: { id: pluginId } },
    },
    "openclaw.plugin.json": {
      id: pluginId,
      channels: [pluginId],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  });
  return { bundledDir, stateDir, pluginRoot };
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  facadeRuntime.resetFacadeRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  originalEnv.restore();
  tempDirs.cleanup();
});

describe("shared runtime seam contracts", () => {
  it("allows activated runtime facades when the resolved plugin root matches an installed-style manifest record", async () => {
    const pluginId = "line-contract-fixture";
    const { bundledDir, stateDir, pluginRoot } = createInstalledRuntimePluginDir(
      pluginId,
      "line-ok",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setRuntimeConfigSnapshot({ plugins: { entries: { [pluginId]: { enabled: true } } } });
    facadeRuntime.resetFacadeRuntimeStateForTest();

    const location = {
      modulePath: path.join(pluginRoot, "runtime-api.js"),
      boundaryRoot: pluginRoot,
    };
    expect(
      activationCheck.resolveBundledPluginPublicSurfaceAccess({
        dirName: pluginId,
        artifactBasename: "runtime-api.js",
        location,
        sourceExtensionsRoot: bundledDir,
      }).allowed,
    ).toBe(true);
    expect(
      facadeRuntime.testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
        location,
        trackedPluginId: pluginId,
      }).marker,
    ).toBe("line-ok");
    expect(facadeRuntime.listImportedBundledPluginFacadeIds()).toEqual([pluginId]);
  });
});
