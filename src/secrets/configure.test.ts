import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryMock = vi.hoisted(() => vi.fn());
const runSecretsApplyMock = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: selectMock,
  text: vi.fn(),
  log: { warn: vi.fn() },
}));

vi.mock("./config-io.js", () => ({
  createSecretsConfigIO: (...args: unknown[]) => createSecretsConfigIOMock(...args),
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (...args: unknown[]) => loadPersistedAuthProfileStoreMock(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

vi.mock("./apply.js", () => ({
  runSecretsApply: (...args: unknown[]) => runSecretsApplyMock(...args),
}));

const { runSecretsConfigureInteractive } = await import("./configure.js");

describe("runSecretsConfigureInteractive", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset();
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });
    loadPersistedAuthProfileStoreMock.mockReset();
    loadPluginManifestRegistryMock.mockReset().mockReturnValue({ diagnostics: [], plugins: [] });
    runSecretsApplyMock.mockReset().mockResolvedValue({
      changed: true,
      changedFiles: [],
      warningCount: 0,
      warnings: [],
      checks: { resolvabilityComplete: true },
      skippedExecRefs: 0,
    });
  });

  it("does not load auth-profiles when running providers-only", async () => {
    selectMock.mockResolvedValue("continue");
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("adds a plugin preset provider through providers-only configure", async () => {
    const pluginRoot = tempDirs.make("openclaw-secrets-configure-");
    fs.chmodSync(pluginRoot, 0o700);
    const resolverPath = path.join(pluginRoot, "vault-secret-ref-resolver.js");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n");
    fs.chmodSync(resolverPath, 0o600);
    selectMock.mockResolvedValueOnce("preset");
    selectMock.mockImplementationOnce(({ options }) => options[0].value);
    selectMock.mockResolvedValueOnce("continue");
    loadPluginManifestRegistryMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "vault",
          origin: "global",
          rootDir: pluginRoot,
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              source: "exec",
              command: "${node}",
              args: ["./vault-secret-ref-resolver.js"],
            },
          },
        },
      ],
    });

    const vault = {
      source: "exec",
      pluginIntegration: { pluginId: "vault", integrationId: "vault" },
    };
    const result = await runSecretsConfigureInteractive({ providersOnly: true, env: {} });
    expect([result.plan.targets, result.plan.providerUpserts?.vault]).toEqual([[], vault]);
    expect(runSecretsApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ providerUpserts: expect.objectContaining({ vault }) }),
        write: false,
        allowExec: false,
      }),
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });
});
