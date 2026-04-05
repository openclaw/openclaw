import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledBrowserPluginFixture } from "../../test/helpers/browser-bundled-plugin-fixture.js";
import type { MullusiConfig } from "../config/config.js";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { clearPluginLoaderCache, loadMullusiPlugins } from "./loader.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

describe("registerPluginCliCommands browser plugin integration", () => {
  let bundledFixture: ReturnType<typeof createBundledBrowserPluginFixture> | null = null;

  beforeEach(() => {
    bundledFixture = createBundledBrowserPluginFixture();
    vi.stubEnv("MULLUSI_BUNDLED_PLUGINS_DIR", bundledFixture.rootDir);
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
    vi.unstubAllEnvs();
    bundledFixture?.cleanup();
    bundledFixture = null;
  });

  it("registers the browser command from the bundled browser plugin", () => {
    const registry = loadMullusiPlugins({
      config: {
        plugins: {
          allow: ["browser"],
        },
      } as MullusiConfig,
      cache: false,
      env: {
        ...process.env,
        MULLUSI_DISABLE_BUNDLED_PLUGINS: undefined,
        MULLUSI_BUNDLED_PLUGINS_DIR:
          bundledFixture?.rootDir ?? path.join(process.cwd(), "extensions"),
      } as NodeJS.ProcessEnv,
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain("browser");
  });

  it("omits the browser command when the bundled browser plugin is disabled", () => {
    const registry = loadMullusiPlugins({
      config: {
        plugins: {
          allow: ["browser"],
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as MullusiConfig,
      cache: false,
      env: {
        ...process.env,
        MULLUSI_DISABLE_BUNDLED_PLUGINS: undefined,
        MULLUSI_BUNDLED_PLUGINS_DIR:
          bundledFixture?.rootDir ?? path.join(process.cwd(), "extensions"),
      } as NodeJS.ProcessEnv,
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain("browser");
  });
});
