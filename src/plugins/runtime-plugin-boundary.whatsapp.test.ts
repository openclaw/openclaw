import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mts";
import { loadFacadeModuleAtLocationSync } from "../plugin-sdk/facade-loader.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

type HeavyModule = {
  registerControllerForTest: (
    accountId: string | null | undefined,
    listener: { sendMessage: () => Promise<{ messageId: string }> } | null,
  ) => void;
};

const tempDirs: string[] = [];

function writeRuntimeFixture(prefix: string, files: Record<string, string | object>) {
  const rootDir = makeTrackedTempDir(prefix, tempDirs);
  writeArtifacts(rootDir, files);
  return rootDir;
}

function createBundledWhatsAppRuntimeFixture() {
  const rootDir = writeRuntimeFixture("openclaw-whatsapp-boundary", {
    "package.json": {
      name: "openclaw",
      type: "module",
      bin: { openclaw: "openclaw.mjs" },
      exports: { "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" } },
    },
    "openclaw.mjs": "export {};\n",
    "dist/plugin-sdk/core.js": "export {};\n",
    [bundledDistPluginFile("whatsapp", "index.js")]: "export default {};\n",
    [bundledDistPluginFile("whatsapp", "light-runtime-api.js")]:
      'export { getActiveWebListener } from "../../active-listener.js";\n',
    [bundledDistPluginFile("whatsapp", "runtime-api.js")]:
      'export { registerControllerForTest } from "../../connection-controller-registry.js";\n',
    "dist/connection-controller-registry.js": `
      const key = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");
      const { controllers } = globalThis[key] ??= { controllers: new Map() };
      export const getRegisteredWhatsAppConnectionController = (id) => controllers.get(id) ?? null;
      export function registerControllerForTest(id, listener) {
        id ??= "default";
        if (listener) controllers.set(id, { getActiveListener: () => listener });
        else controllers.delete(id);
      }
    `,
    "dist/active-listener.js": `
      import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
      export const getActiveWebListener = (id) =>
        getRegisteredWhatsAppConnectionController(id ?? "default")?.getActiveListener() ?? null;
    `,
  });
  stageBundledPluginRuntime({ repoRoot: rootDir });

  return path.join(rootDir, "dist-runtime", "extensions", "whatsapp");
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("runtime plugin boundary whatsapp seam", () => {
  it("shares listener state between staged light and heavy runtime modules", () => {
    const runtimePluginDir = createBundledWhatsAppRuntimeFixture();
    const boundary = { boundaryLabel: "bundled plugin root", rejectHardlinks: false };
    const light = loadFacadeModuleAtLocationSync<{
      getActiveWebListener: (accountId?: string | null) => unknown;
    }>({
      location: {
        modulePath: path.join(runtimePluginDir, "light-runtime-api.js"),
        boundaryRoot: runtimePluginDir,
      },
      boundary,
    });
    const heavy = loadFacadeModuleAtLocationSync<HeavyModule>({
      location: {
        modulePath: path.join(runtimePluginDir, "runtime-api.js"),
        boundaryRoot: runtimePluginDir,
      },
      boundary,
    });
    const listener = { sendMessage: async () => ({ messageId: "msg-1" }) };
    heavy.registerControllerForTest("work", listener);
    expect(light.getActiveWebListener("work")).toBe(listener);
    heavy.registerControllerForTest("work", null);
  });

  it("keeps the TypeScript source package fallback available for non-bundled plugins", () => {
    const root = writeRuntimeFixture("openclaw-external-boundary-ts", {
      "package.json": { name: "openclaw-external-ts-runtime", type: "module" },
      "runtime-api.ts": `import { marker } from "./runtime-helper.js";
export const ok = true;
export const loadedVia = marker;
`,
      "runtime-helper.ts": 'export const marker = "jiti-source-package";\n',
    });
    expect(
      loadFacadeModuleAtLocationSync<{ ok: boolean; loadedVia: string }>({
        location: { modulePath: path.join(root, "runtime-api.ts"), boundaryRoot: root },
      }),
    ).toEqual({ ok: true, loadedVia: "jiti-source-package" });
  });
});
