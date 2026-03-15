import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  createExtensionHostLoaderSession,
  finalizeExtensionHostLoaderSession,
  processExtensionHostLoaderSessionCandidate,
} from "./loader-session.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempPluginFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-loader-session-"));
  tempDirs.push(rootDir);
  const entryPath = path.join(rootDir, "index.js");
  fs.writeFileSync(entryPath, "export default { id: 'demo', register() {} }");
  return { rootDir, entryPath };
}

function createManifestRecord(rootDir: string, entryPath: string): PluginManifestRecord {
  return {
    id: "demo",
    name: "Demo",
    description: "Demo plugin",
    version: "1.0.0",
    kind: "memory",
    channels: [],
    providers: [],
    skills: [],
    origin: "bundled",
    rootDir,
    source: entryPath,
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    schemaCacheKey: "demo-schema",
    configSchema: {
      type: "object",
      properties: {},
    },
    resolvedExtension: {
      id: "demo",
      source: entryPath,
      origin: "bundled",
      rootDir,
      static: {
        package: {},
        config: {},
        setup: {},
      },
      runtime: {
        kind: "memory",
        contributions: [],
      },
      policy: {},
    },
  };
}

function createRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("extension host loader session", () => {
  it("owns mutable activation state for memory-slot selection", () => {
    const { rootDir, entryPath } = createTempPluginFixture();
    const session = createExtensionHostLoaderSession({
      registry: createRegistry(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      env: process.env,
      provenance: {
        loadPathMatcher: { exact: new Set(), dirs: [] },
        installRules: new Map(),
      },
      cacheEnabled: false,
      cacheKey: "cache-key",
      memorySlot: "demo",
      setCachedRegistry: () => {},
      activateRegistry: () => {},
    });

    processExtensionHostLoaderSessionCandidate({
      session,
      candidate: {
        source: entryPath,
        rootDir,
        packageDir: rootDir,
        origin: "bundled",
      },
      manifestRecord: createManifestRecord(rootDir, entryPath),
      normalizedConfig: normalizePluginsConfig({
        slots: {
          memory: "demo",
        },
      }),
      rootConfig: {},
      validateOnly: true,
      createApi: () => ({}) as never,
      loadModule: () =>
        ({
          default: {
            id: "demo",
            register: () => {},
          },
        }) as never,
    });

    expect(session.selectedMemoryPluginId).toBe("demo");
    expect(session.memorySlotMatched).toBe(true);
    expect(session.registry.plugins[0]?.lifecycleState).toBe("validated");
  });

  it("finalizes the session through the shared finalizer", () => {
    const session = createExtensionHostLoaderSession({
      registry: createRegistry(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      env: process.env,
      provenance: {
        loadPathMatcher: { exact: new Set(), dirs: [] },
        installRules: new Map(),
      },
      cacheEnabled: false,
      cacheKey: "cache-key",
      setCachedRegistry: () => {},
      activateRegistry: () => {},
    });

    const result = finalizeExtensionHostLoaderSession(session);

    expect(result).toBe(session.registry);
  });
});
