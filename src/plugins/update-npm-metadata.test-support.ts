import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, it, vi, type Mock } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { expectIntegrityDriftRejected } from "../test-utils/npm-spec-install-test-helpers.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";

type NpmFixturePackage = {
  spec: string;
  npmRoot: string;
  packageName: string;
  version: string;
  pluginId?: string;
  expectedDependencySpec?: string;
  versions?: string[];
  openclaw?: { extensions: string[]; compat?: { pluginApi: string } };
};

export function registerNpmUpdateMetadataTests({
  getNpmRoot,
  installPluginFromNpmSpec,
  isManagedNpmInstallCommand,
  mockNpmViewAndInstallMany,
  runCommandWithTimeoutMock,
  writeInstalledNpmPlugin,
}: {
  getNpmRoot: () => string;
  installPluginFromNpmSpec: typeof import("./install.js").installPluginFromNpmSpec;
  isManagedNpmInstallCommand: (argv: unknown) => boolean;
  mockNpmViewAndInstallMany: (packages: NpmFixturePackage[]) => void;
  runCommandWithTimeoutMock: Mock<typeof runCommandWithTimeout>;
  writeInstalledNpmPlugin: (params: Omit<NpmFixturePackage, "spec">) => string;
}) {
  const silentLogger = { info: () => {}, warn: () => {} };
  const consent: PluginCapabilityConsentHandler = async (review) => ({
    reviewToken: review.reviewToken,
  });
  const metadataCommands = () =>
    runCommandWithTimeoutMock.mock.calls
      .map(([argv]) => npmCommandArgs(argv))
      .filter((args): args is string[] => args?.[0] === "view");
  const metadataSpecs = () =>
    metadataCommands()
      .map((args) => expectDefined(args[1], "npm view package spec"))
      .toSorted((left, right) => left.localeCompare(right));
  function installedConfig(pluginId: string, record: PluginInstallRecord) {
    return {
      plugins: { entries: { [pluginId]: { enabled: true } }, installs: { [pluginId]: record } },
    };
  }
  function expectInstalled(
    record: PluginInstallRecord | undefined,
    packageName: string,
    version: string,
  ) {
    expect(record).toMatchObject({
      resolvedName: packageName,
      resolvedVersion: version,
      integrity: "sha512-plugin-test",
    });
    assert(record?.installPath);
    expect(
      JSON.parse(fs.readFileSync(path.join(record.installPath, "package.json"), "utf8")),
    ).toMatchObject({ name: packageName, version });
  }
  async function updateInstalled(
    params: Parameters<typeof import("./update-installed.js").updateNpmInstalledPlugins>[0],
  ) {
    const { updateNpmInstalledPlugins } = await import("./update-installed.js");
    return withPluginInstallRoots({ ...resolvePluginInstallRoots(), npmDir: getNpmRoot() }, () =>
      updateNpmInstalledPlugins({ logger: silentLogger, onCapabilityConsent: consent, ...params }),
    );
  }
  function npmPackage(
    spec: string,
    version: string,
    overrides: Partial<NpmFixturePackage> = {},
  ): NpmFixturePackage {
    return { spec, version, npmRoot: getNpmRoot(), packageName: spec, ...overrides };
  }
  function mockMissingNpmVersion(spec: string) {
    const run = expectDefined(runCommandWithTimeoutMock.getMockImplementation(), "npm fixture");
    runCommandWithTimeoutMock.mockImplementation((argv, options) =>
      npmCommandArgs(argv)?.[1] === spec
        ? Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "npm error code E404",
            signal: null,
            killed: false,
            termination: "exit",
          })
        : run(argv, options),
    );
  }
  it.each([
    ["beta", "stable", true, true, "2026.11.1", "latest"],
    ["next", "stable", true, true, "2026.11.1", "latest"],
    ["beta", "stable", true, false, "2026.11.2", "latest"],
    ["2026.11.8", "stable", true, true, "2026.11.8", "2026.11.8"],
    ["^2026.11.0", "stable", true, true, "2026.10.10-beta.5", "^2026.11.0"],
    ["beta", "stable", false, true, "2026.10.10-beta.5", "beta"],
    ["beta", "beta", true, true, "2026.11.5-beta.1", "beta"],
  ] as const)(
    "updates stored @%s on %s (official=%s, core published=%s)",
    async (selector, updateChannel, official, corePublished, expectedVersion, savedSelector) => {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      const packageName = official ? "@openclaw/voice-call" : "channel-fixture";
      const pluginId = official ? "voice-call" : "channel-fixture";
      const available = { npmRoot: getNpmRoot(), packageName, pluginId };
      const initialVersion = "2026.10.10-beta.5";
      const installPath = writeInstalledNpmPlugin({
        ...available,
        npmRoot: path.join(getNpmRoot(), "previous"),
        version: initialVersion,
      });
      mockNpmViewAndInstallMany([
        ...(!corePublished ? [] : [npmPackage(`${packageName}@2026.11.1`, "2026.11.1", available)]),
        npmPackage(`${packageName}@latest`, "2026.11.2", available),
        npmPackage(
          `${packageName}@beta`,
          official ? "2026.11.5-beta.1" : initialVersion,
          available,
        ),
        npmPackage(`${packageName}@next`, "2026.11.5-beta.1", available),
        npmPackage(`${packageName}@^2026.11.0`, initialVersion, available),
        npmPackage(`${packageName}@${expectedVersion}`, expectedVersion, {
          ...available,
          expectedDependencySpec: expectedVersion,
        }),
      ]);
      if (!corePublished) {
        mockMissingNpmVersion(`${packageName}@2026.11.1`);
      }
      const warn = vi.fn();
      const result = await updateInstalled({
        config: installedConfig(pluginId, {
          source: "npm",
          spec: `${packageName}@${selector}`,
          installPath,
          version: initialVersion,
          resolvedName: packageName,
          resolvedSpec: `${packageName}@${initialVersion}`,
          resolvedVersion: initialVersion,
          integrity: "sha512-plugin-test",
        }),
        updateChannel,
        coreVersion: "2026.11.1",
        logger: { warn },
      });
      expectInstalled(result.config.plugins?.installs?.[pluginId], packageName, expectedVersion);
      expect(result.config.plugins?.installs?.[pluginId]?.spec).toBe(
        `${packageName}@${savedSelector}`,
      );
      if (selector !== savedSelector) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("stable"));
      }
    },
  );
  it.each(["older stable", "prerelease only"])(
    "retains the installed plugin when stable recovery offers %s",
    async (scenario) => {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      const packageName = "@openclaw/voice-call";
      const pluginId = "voice-call";
      const currentVersion = "2026.11.1";
      const oldStable = "2026.10.10";
      const oldBeta = "2026.10.10-beta.5";
      const available = { npmRoot: getNpmRoot(), packageName, pluginId };
      const installPath = writeInstalledNpmPlugin({
        ...available,
        npmRoot: path.join(getNpmRoot(), "previous"),
        version: currentVersion,
      });
      const incompatible = {
        extensions: ["./dist/index.js"],
        compat: { pluginApi: ">=2026.11.5" },
      };
      mockNpmViewAndInstallMany([
        npmPackage(`${packageName}@beta`, "2026.11.5-beta.1", {
          ...available,
          openclaw: incompatible,
          versions:
            scenario === "older stable"
              ? [oldBeta, oldStable, "2026.11.5"]
              : [oldBeta, "2026.11.5-beta.1"],
        }),
        npmPackage(`${packageName}@latest`, scenario === "older stable" ? "2026.11.5" : oldBeta, {
          ...available,
          ...(scenario === "older stable" ? { openclaw: incompatible } : {}),
        }),
        npmPackage(`${packageName}@${oldBeta}`, oldBeta, available),
        npmPackage(`${packageName}@2026.11.5-beta.1`, "2026.11.5-beta.1", {
          ...available,
          openclaw: incompatible,
        }),
        npmPackage(`${packageName}@${oldStable}`, oldStable, available),
      ]);
      mockMissingNpmVersion(`${packageName}@${currentVersion}`);
      const record = {
        source: "npm" as const,
        spec: `${packageName}@beta`,
        installPath,
        version: currentVersion,
        resolvedName: packageName,
        resolvedSpec: `${packageName}@${currentVersion}`,
        resolvedVersion: currentVersion,
      };
      const warn = vi.fn();
      const result = await updateInstalled({
        config: installedConfig(pluginId, record),
        updateChannel: "stable",
        coreVersion: currentVersion,
        logger: { warn },
      });
      expect(result.config.plugins?.installs?.[pluginId]).toEqual(record);
      expect(
        JSON.parse(fs.readFileSync(path.join(installPath, "package.json"), "utf8")).version,
      ).toBe(currentVersion);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Keeping "voice-call"'));
    },
  );
  it.each(["spec", "trust"])(
    "rejects prepared fallback facts after %s changes",
    async (changed) => {
      const spec = "@openclaw/voice-call";
      mockNpmViewAndInstallMany([
        npmPackage(spec, "3.0.0-beta.1", {
          versions: ["2.0.0", "3.0.0-beta.1"],
        }),
        npmPackage(`${spec}@2.0.0`, "2.0.0", {
          packageName: spec,
          pluginId: "voice-call",
          expectedDependencySpec: "2.0.0",
        }),
      ]);
      const warn = vi.fn();
      const result = await installPluginFromNpmSpec({
        spec,
        expectedPluginId: "voice-call",
        trustedSourceLinkedOfficialInstall: changed !== "trust",
        logger: { info: () => {}, warn },
        npmMetadata: {
          spec: changed === "spec" ? `${spec}@latest` : spec,
          metadata: { name: spec, version: "3.0.0-beta.1" },
          trustedPrereleaseResolution: {
            kind: "stable",
            resolvedPrereleaseVersion: "3.0.0-beta.1",
            resolution: { name: spec, version: "99.0.0", resolvedSpec: `${spec}@99.0.0` },
            warning: "stale fallback warning",
          },
        },
      });
      expect(warn).not.toHaveBeenCalledWith("stale fallback warning");
      if (changed === "trust") {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("prerelease version"),
        });
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
        return;
      }
      expect(result).toMatchObject({
        ok: true,
        version: "2.0.0",
        npmResolution: { name: spec, version: "2.0.0" },
      });
      expect(
        metadataCommands().filter((args) => args[1] === spec && args[2] === "name"),
      ).toHaveLength(1);
    },
  );

  it("reuses beta metadata when replacing an externalized bundled plugin", async () => {
    const { syncPluginsForUpdateChannel } = await import("./update-channel.js");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const npmRoot = getNpmRoot();
    const packageName = "@openclaw/voice-call";
    const pluginId = "voice-call";
    const available = { npmRoot, packageName, pluginId, version: "2.0.0" };
    mockNpmViewAndInstallMany([
      { ...available, spec: `${packageName}@beta`, version: "1.5.0-beta.1" },
      { ...available, spec: `${packageName}@latest` },
      { ...available, spec: `${packageName}@2.0.0` },
    ]);
    const result = await withPluginInstallRoots(
      { ...resolvePluginInstallRoots(), npmDir: npmRoot },
      () =>
        syncPluginsForUpdateChannel({
          config: { plugins: { entries: { [pluginId]: { enabled: true } } } },
          externalizedBundledPluginBridges: [{ bundledPluginId: pluginId, npmSpec: packageName }],
          channel: "beta",
          logger: silentLogger,
          onCapabilityConsent: consent,
        }),
    );
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.switchedToNpm).toEqual([pluginId]);
    expect(result.config.plugins?.installs?.[pluginId]).toMatchObject({
      resolvedName: packageName,
      resolvedVersion: "2.0.0",
      integrity: "sha512-plugin-test",
    });
    expect(metadataSpecs()).toEqual([`${packageName}@beta`, `${packageName}@latest`]);
  });

  it.each<[string, string, string, string | undefined]>([
    ["stable", "1.0.0", "2.0.0", undefined],
    ["newest prerelease", "2.0.0-beta.1", "3.0.0-beta.1", "using newest prerelease"],
    ["allowed current prerelease", "3.0.0-beta.1", "3.0.0-beta.1", "allowing it"],
  ])(
    "reuses successful update metadata for %s",
    async (_label, initialVersion, selectedVersion, warning) => {
      const official = warning !== undefined;
      if (official) {
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      }
      const npmRoot = getNpmRoot();
      const packageName = official ? "@openclaw/voice-call" : "update-metadata-fixture";
      const pluginId = official ? "voice-call" : "metadata-fixture";
      const available = { npmRoot, packageName, pluginId };
      const installPath = writeInstalledNpmPlugin({
        ...available,
        npmRoot: path.join(npmRoot, "previous"),
        version: initialVersion,
      });
      mockNpmViewAndInstallMany([
        {
          ...available,
          spec: packageName,
          version: official ? initialVersion : selectedVersion,
          ...(official
            ? { versions: ["2.0.0-beta.1", "3.0.0-beta.1"] }
            : { expectedDependencySpec: selectedVersion }),
        },
        {
          ...available,
          spec: `${packageName}@${selectedVersion}`,
          version: selectedVersion,
          expectedDependencySpec: selectedVersion,
        },
      ]);
      const warnings: string[] = [];
      const result = await updateInstalled({
        config: installedConfig(pluginId, {
          source: "npm",
          spec: packageName,
          installPath,
          version: initialVersion,
          ...(official
            ? {
                resolvedName: packageName,
                resolvedSpec: `${packageName}@${initialVersion}`,
                resolvedVersion: initialVersion,
                integrity: "sha512-plugin-test",
              }
            : {}),
        }),
        ...(official
          ? { logger: { info: () => {}, warn: (message: string) => warnings.push(message) } }
          : { updateChannel: "stable" as const }),
      });
      expect(result.outcomes, JSON.stringify(result.outcomes)).toMatchObject([
        {
          pluginId,
          status: initialVersion === selectedVersion ? "unchanged" : "updated",
          currentVersion: initialVersion,
          nextVersion: selectedVersion,
        },
      ]);
      const record = result.config.plugins?.installs?.[pluginId];
      expectInstalled(record, packageName, selectedVersion);
      if (!official) {
        expect(record?.spec).toBe(packageName);
        expect(metadataSpecs()).toEqual([packageName]);
        return;
      }
      const commands = metadataCommands();
      expect(commands.filter((args) => args[2] === "versions")).toHaveLength(1);
      expect(
        commands.filter((args) => args[1] === `${packageName}@${selectedVersion}`),
      ).toHaveLength(initialVersion === selectedVersion ? 0 : 1);
      expect(
        runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
      ).toBe(true);
      expect(
        warnings.filter((message) => message.startsWith(`Resolved ${packageName} to `)),
      ).toEqual([expect.stringContaining(warning)]);
    },
  );

  it("checks integrity with prepared fallback npm metadata", async () => {
    const onIntegrityDrift = vi.fn(async () => false);
    const spec = "@openclaw/voice-call";
    const result = await installPluginFromNpmSpec({
      spec,
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      trustedSourceLinkedOfficialInstall: true,
      npmMetadata: {
        spec,
        metadata: {
          name: spec,
          version: "0.0.2-beta.1",
          integrity: "sha512-old",
          shasum: "newshasum",
        },
        trustedPrereleaseResolution: {
          kind: "stable",
          resolvedPrereleaseVersion: "0.0.2-beta.1",
          resolution: {
            name: spec,
            version: "0.0.1",
            integrity: "sha512-new",
            shasum: "newshasum",
          },
          warning: "falling back to stable @openclaw/voice-call@0.0.1",
        },
      },
    });
    expectIntegrityDriftRejected({
      onIntegrityDrift,
      result,
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(false);
  });
}
