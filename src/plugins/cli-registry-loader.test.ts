import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginLogger } from "./types.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
}));

let loadPluginCliRegistrationEntries: typeof import("./cli-registry-loader.js").loadPluginCliRegistrationEntries;

const logger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createManifestRegistry(params?: { wikiRequiresSlots?: string[] }) {
  return {
    plugins: [
      {
        id: "memory-core",
        kind: "memory",
        providers: [],
        channels: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        origin: "bundled",
      },
      {
        id: "memory-lancedb",
        kind: "memory",
        providers: [],
        channels: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        origin: "bundled",
      },
      {
        id: "memory-wiki",
        activation:
          params?.wikiRequiresSlots === undefined
            ? undefined
            : { requiresSlots: params.wikiRequiresSlots },
        providers: [],
        channels: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        origin: "bundled",
      },
    ],
    diagnostics: [],
  };
}

describe("plugin CLI registry loader", () => {
  beforeAll(async () => {
    ({ loadPluginCliRegistrationEntries } = await import("./cli-registry-loader.js"));
  });

  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadOpenClawPluginCliRegistry.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [],
      diagnostics: [],
    });
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({
      cliRegistrars: [],
      diagnostics: [],
    });
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createManifestRegistry());
    mocks.resolveManifestActivationPluginIds.mockReset();
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
  });

  it("loads required selected slot plugins with a scoped primary plugin command", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-wiki"]);
    mocks.loadPluginManifestRegistry.mockReturnValue(
      createManifestRegistry({ wikiRequiresSlots: ["memory"] }),
    );

    await loadPluginCliRegistrationEntries({
      cfg: {
        plugins: {
          slots: { memory: "memory-lancedb" },
        },
      } as OpenClawConfig,
      logger,
      primaryCommand: "wiki",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-lancedb", "memory-wiki"],
      }),
    );
  });

  it("does not load a required slot when the selected slot is none", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-wiki"]);
    mocks.loadPluginManifestRegistry.mockReturnValue(
      createManifestRegistry({ wikiRequiresSlots: ["memory"] }),
    );

    await loadPluginCliRegistrationEntries({
      cfg: {
        plugins: {
          slots: { memory: "none" },
        },
      } as OpenClawConfig,
      logger,
      primaryCommand: "wiki",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-wiki"],
      }),
    );
  });
});
