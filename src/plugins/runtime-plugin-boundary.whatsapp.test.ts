import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";
import { bundledDistPluginFile } from "../../test/helpers/bundled-plugin-paths.js";
import { loadPluginBoundaryModuleWithJiti } from "./runtime/runtime-plugin-boundary.js";

type LightModule = {
  getActiveWebListener: (accountId?: string | null) => unknown;
};

type HeavyModule = {
  setActiveWebListener: (
    accountId: string | null | undefined,
    listener: { sendMessage: () => Promise<{ messageId: string }> } | null,
  ) => void;
};

const tempDirs: string[] = [];

function writeRuntimeFixtureText(rootDir: string, relativePath: string, value: string) {
  fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf8");
}

function createBundledWhatsAppRuntimeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-whatsapp-boundary-"));
  tempDirs.push(rootDir);
  for (const [relativePath, value] of Object.entries({
    "package.json": JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        bin: {
          openclaw: "openclaw.mjs",
        },
        exports: {
          "./plugin-sdk": {
            default: "./dist/plugin-sdk/index.js",
          },
        },
      },
      null,
      2,
    ),
    "openclaw.mjs": "export {};\n",
    [bundledDistPluginFile("whatsapp", "index.js")]: "export default {};\n",
    [bundledDistPluginFile("whatsapp", "light-runtime-api.js")]:
      'export { getActiveWebListener } from "../../active-listener.js";\n',
    [bundledDistPluginFile("whatsapp", "runtime-api.js")]:
      'export { getActiveWebListener, setActiveWebListener } from "../../active-listener.js";\n',
    "dist/active-listener.js": [
      'const key = Symbol.for("openclaw.whatsapp.activeListenerState");',
      "const g = globalThis;",
      "if (!g[key]) {",
      "  g[key] = { listeners: new Map(), current: null };",
      "}",
      "const state = g[key];",
      "export function setActiveWebListener(accountIdOrListener, maybeListener) {",
      '  const accountId = typeof accountIdOrListener === "string" ? accountIdOrListener : "default";',
      '  const listener = typeof accountIdOrListener === "string" ? (maybeListener ?? null) : (accountIdOrListener ?? null);',
      "  if (!listener) state.listeners.delete(accountId);",
      "  else state.listeners.set(accountId, listener);",
      '  if (accountId === "default") state.current = listener;',
      "}",
      "export function getActiveWebListener(accountId) {",
      '  return state.listeners.get(accountId ?? "default") ?? null;',
      "}",
      "",
    ].join("\n"),
  })) {
    writeRuntimeFixtureText(rootDir, relativePath, value);
  }
  stageBundledPluginRuntime({ repoRoot: rootDir });

  return path.join(rootDir, "dist-runtime", "extensions", "whatsapp");
}

function loadWhatsAppBoundaryModules(runtimePluginDir: string) {
  const loaders = new Map<boolean, ReturnType<typeof import("jiti").createJiti>>();
  return {
    light: loadPluginBoundaryModuleWithJiti<LightModule>(
      path.join(runtimePluginDir, "light-runtime-api.js"),
      loaders,
    ),
    heavy: loadPluginBoundaryModuleWithJiti<HeavyModule>(
      path.join(runtimePluginDir, "runtime-api.js"),
      loaders,
    ),
  };
}

function createListener(messageId = "msg-1") {
  return {
    sendMessage: async () => ({ messageId }),
  };
}

function expectSharedWhatsAppListenerState(runtimePluginDir: string, accountId: string) {
  const { light, heavy } = loadWhatsAppBoundaryModules(runtimePluginDir);
  const listener = createListener();

  heavy.setActiveWebListener(accountId, listener);
  expect(light.getActiveWebListener(accountId)).toBe(listener);
  heavy.setActiveWebListener(accountId, null);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime plugin boundary whatsapp seam", () => {
  it("shares listener state between staged light and heavy runtime modules", () => {
    expectSharedWhatsAppListenerState(createBundledWhatsAppRuntimeFixture(), "work");
  });
});
