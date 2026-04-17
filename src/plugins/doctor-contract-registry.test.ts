import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.js").clearPluginDoctorContractRegistryCache;
let collectRelevantDoctorPluginIdsForTouchedPaths: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIdsForTouchedPaths;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry getJiti", () => {
  beforeEach(async () => {
    resetRegistryJitiMocks();
    vi.resetModules();
    ({
      clearPluginDoctorContractRegistryCache,
      collectRelevantDoctorPluginIdsForTouchedPaths,
      listPluginDoctorLegacyConfigRules,
    } = await import("./doctor-contract-registry.js"));
    clearPluginDoctorContractRegistryCache();
  });

  it("disables native jiti loading on Windows for contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "contract-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      listPluginDoctorLegacyConfigRules({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "contract-api.js"));
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: false,
      }),
    );
  });

  it("enables native jiti loading on Linux for contract-api modules (#68282)", () => {
    // Reporter measured ~15.7s first-call cost for `openclaw status` dominated
    // by doctor contract loading on the default (non-native) jiti path, vs
    // ~2.1s with `tryNative: true`. Assert the Linux path requests native
    // loading explicitly so the default `dist/extensions/*` gate in
    // `resolvePluginLoaderJitiTryNative` does not downgrade us.
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "contract-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    try {
      listPluginDoctorLegacyConfigRules({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: true,
      }),
    );
  });

  it("prefers doctor-contract-api over the broader contract-api surface", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.js"),
      "export default {};\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(pluginRoot, "contract-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    listPluginDoctorLegacyConfigRules({
      workspaceDir: pluginRoot,
      env: {},
    });

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(
      path.join(pluginRoot, "doctor-contract-api.js"),
    );
  });

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
          talk: {
            voiceId: "legacy-voice",
          },
        },
        touchedPaths: [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["talk", "voiceId"],
        ],
      }),
    ).toEqual(["discord", "elevenlabs", "memory-wiki"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
        },
        touchedPaths: [["channels"]],
      }),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });
});
