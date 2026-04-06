import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../../infra/net/undici-runtime.js";
import type { PluginManifestRecord } from "../manifest-registry.js";

const loadPluginManifestRegistryMock = vi.fn();

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalGlobalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function createRuntimePluginDir(pluginId: string, marker: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-runtime-contract-${pluginId}-`));
  tempDirs.push(rootDir);
  const pluginRoot = path.join(rootDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "runtime-api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  return pluginRoot;
}

function buildPluginManifestRecord(params: {
  id: string;
  origin: PluginManifestRecord["origin"];
  rootDir: string;
}): PluginManifestRecord {
  return {
    id: params.id,
    origin: params.origin,
    rootDir: params.rootDir,
    source: params.rootDir,
    manifestPath: path.join(params.rootDir, "openclaw.plugin.json"),
    channels: [params.id],
    providers: [],
    skills: [],
    hooks: [],
  };
}

afterEach(() => {
  loadPluginManifestRegistryMock.mockReset();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../manifest-registry.js");
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalGlobalFetch) {
    (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
  } else {
    Reflect.deleteProperty(globalThis as object, "fetch");
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shared runtime seam contracts", () => {
  it("allows activated runtime facades when the resolved plugin root matches an installed-style manifest record", async () => {
    const pluginRoot = createRuntimePluginDir("line", "line-ok");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.dirname(pluginRoot);
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          line: {
            enabled: true,
          },
        },
      },
    });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [buildPluginManifestRecord({ id: "line", origin: "global", rootDir: pluginRoot })],
      diagnostics: [],
    });
    vi.doMock("../manifest-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("../manifest-registry.js")>("../manifest-registry.js");
      return {
        ...actual,
        loadPluginManifestRegistry: (
          ...args: Parameters<typeof actual.loadPluginManifestRegistry>
        ) => loadPluginManifestRegistryMock(...args),
      };
    });

    const facadeRuntime = await import("../../plugin-sdk/facade-runtime.js");
    facadeRuntime.resetFacadeRuntimeStateForTest();

    expect(
      facadeRuntime.canLoadActivatedBundledPluginPublicSurface({
        dirName: "line",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
    expect(
      facadeRuntime.loadActivatedBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "line",
        artifactBasename: "runtime-api.js",
      }).marker,
    ).toBe("line-ok");
    expect(facadeRuntime.listImportedBundledPluginFacadeIds()).toEqual(["line"]);
  });

  it("keeps guarded fetch on mocked global fetches even when a dispatcher is attached", async () => {
    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    const runtimeFetch = vi.fn(async () => new Response("runtime", { status: 200 }));
    const globalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeDefined();
      return new Response("mock", { status: 200 });
    });

    (globalThis as Record<string, unknown>).fetch = globalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    const lookupFn = vi.fn(
      async () => ({ address: "93.184.216.34", family: 4 }) as const,
    ) as unknown as NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      lookupFn,
    });

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(await result.response.text()).toBe("mock");
    await result.release();
  });
});
