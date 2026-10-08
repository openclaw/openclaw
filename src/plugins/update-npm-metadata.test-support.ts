import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, it, vi, type Mock } from "vitest";
import type { runCommandWithTimeout } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { expectIntegrityDriftRejected } from "../test-utils/npm-spec-install-test-helpers.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";

type NpmFixturePackage = {
  spec: string;
  npmRoot: string;
  packageName: string;
  version: string;
  pluginId?: string;
  expectedDependencySpec?: string;
  versions?: string[];
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
  it.each(["spec", "trust"])(
    "rejects prepared fallback facts after %s changes",
    async (changed) => {
      const spec = "@openclaw/voice-call";
      const npmRoot = getNpmRoot();
      mockNpmViewAndInstallMany([
        {
          spec,
          npmRoot,
          packageName: spec,
          version: "3.0.0-beta.1",
          versions: ["2.0.0", "3.0.0-beta.1"],
        },
        {
          spec: `${spec}@2.0.0`,
          npmRoot,
          packageName: spec,
          pluginId: "voice-call",
          version: "2.0.0",
          expectedDependencySpec: "2.0.0",
        },
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
        runCommandWithTimeoutMock.mock.calls.filter(([argv]) => {
          const args = npmCommandArgs(argv);
          return args?.[0] === "view" && args[1] === spec && args[2] === "name";
        }),
      ).toHaveLength(changed === "spec" ? 1 : 0);
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
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        }),
    );
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.switchedToNpm).toEqual([pluginId]);
    expect(result.config.plugins?.installs?.[pluginId]).toMatchObject({
      resolvedName: packageName,
      resolvedVersion: "2.0.0",
      integrity: "sha512-plugin-test",
    });
    expect(
      runCommandWithTimeoutMock.mock.calls
        .map(([argv]) => npmCommandArgs(argv))
        .filter((args): args is string[] => args?.[0] === "view")
        .map((args) => expectDefined(args[1], "npm view package spec"))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([`${packageName}@beta`, `${packageName}@latest`]);
  });

  it.each(["stable", "beta"] as const)(
    "reuses the %s update selection without another npm metadata command",
    async (channel) => {
      const { updateNpmInstalledPlugins } = await import("./update-installed.js");
      const npmRoot = getNpmRoot();
      const packageName = "update-metadata-fixture";
      const pluginId = "metadata-fixture";
      const installPath = writeInstalledNpmPlugin({
        npmRoot: path.join(npmRoot, "previous"),
        packageName,
        pluginId,
        version: "1.0.0",
      });
      const available = {
        npmRoot,
        packageName,
        pluginId,
        version: "2.0.0",
        expectedDependencySpec: "2.0.0",
      };
      mockNpmViewAndInstallMany([
        { ...available, spec: packageName },
        { ...available, spec: `${packageName}@latest` },
        { ...available, spec: `${packageName}@beta`, version: "1.5.0-beta.1" },
        { ...available, spec: `${packageName}@2.0.0` },
      ]);
      const result = await withPluginInstallRoots(
        { ...resolvePluginInstallRoots(), npmDir: npmRoot },
        () =>
          updateNpmInstalledPlugins({
            config: {
              plugins: {
                entries: { [pluginId]: { enabled: true } },
                installs: {
                  [pluginId]: {
                    source: "npm",
                    spec: packageName,
                    installPath,
                    version: "1.0.0",
                  },
                },
              },
            },
            updateChannel: channel,
            logger: silentLogger,
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          }),
      );
      expect(result.outcomes, JSON.stringify(result.outcomes)).toMatchObject([
        { pluginId, status: "updated", currentVersion: "1.0.0", nextVersion: "2.0.0" },
      ]);
      const record = result.config.plugins?.installs?.[pluginId];
      expect(record).toMatchObject({
        spec: packageName,
        resolvedName: packageName,
        resolvedVersion: "2.0.0",
        integrity: "sha512-plugin-test",
      });
      assert(record?.installPath);
      expect(
        JSON.parse(fs.readFileSync(path.join(record.installPath, "package.json"), "utf8")),
      ).toMatchObject({ name: packageName, version: "2.0.0" });
      const metadataCommands = runCommandWithTimeoutMock.mock.calls
        .map(([argv]) => npmCommandArgs(argv))
        .filter((args): args is string[] => args?.[0] === "view")
        .map((args) => expectDefined(args[1], "npm view package spec"));
      expect(metadataCommands.toSorted((left, right) => left.localeCompare(right))).toEqual(
        channel === "beta" ? [`${packageName}@beta`, `${packageName}@latest`] : [packageName],
      );
    },
  );

  it.each([
    {
      label: "newest prerelease",
      initialVersion: "2.0.0-beta.1",
      versions: ["2.0.0-beta.1", "3.0.0-beta.1"],
      selectedVersion: "3.0.0-beta.1",
      warning: "using newest prerelease",
      retry: false,
    },
    {
      label: "allowed current prerelease",
      initialVersion: "3.0.0-beta.1",
      versions: ["2.0.0-beta.1", "3.0.0-beta.1"],
      selectedVersion: "3.0.0-beta.1",
      warning: "allowing it",
      retry: false,
    },
    {
      label: "retry after unavailable preparation",
      initialVersion: "3.0.0-beta.1",
      versions: ["2.0.0", "3.0.0-beta.1"],
      selectedVersion: "2.0.0",
      warning: "falling back to stable",
      retry: true,
    },
  ])("reuses successful official update metadata for $label", async (scenario) => {
    const { updateNpmInstalledPlugins } = await import("./update-installed.js");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const npmRoot = getNpmRoot();
    const packageName = "@openclaw/voice-call";
    const pluginId = "voice-call";
    const installPath = writeInstalledNpmPlugin({
      npmRoot: path.join(npmRoot, "previous"),
      packageName,
      pluginId,
      version: scenario.initialVersion,
    });
    mockNpmViewAndInstallMany([
      {
        spec: packageName,
        npmRoot,
        packageName,
        pluginId,
        version: scenario.initialVersion,
        versions: scenario.versions,
      },
      {
        spec: `${packageName}@${scenario.selectedVersion}`,
        npmRoot,
        packageName,
        pluginId,
        version: scenario.selectedVersion,
        expectedDependencySpec: scenario.selectedVersion,
      },
    ]);
    if (scenario.retry) {
      const runNpm = expectDefined(
        runCommandWithTimeoutMock.getMockImplementation(),
        "npm fixture",
      );
      let failed = false;
      runCommandWithTimeoutMock.mockImplementation(async (...args) => {
        if (!failed && npmCommandArgs(args[0])?.[2] === "versions") {
          failed = true;
          return {
            code: 1,
            stdout: "",
            stderr: "registry temporarily unavailable",
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return await runNpm(...args);
      });
    }
    const warnings: string[] = [];
    const result = await withPluginInstallRoots(
      { ...resolvePluginInstallRoots(), npmDir: npmRoot },
      () =>
        updateNpmInstalledPlugins({
          config: {
            plugins: {
              entries: { [pluginId]: { enabled: true } },
              installs: {
                [pluginId]: {
                  source: "npm",
                  spec: packageName,
                  installPath,
                  version: scenario.initialVersion,
                  resolvedName: packageName,
                  resolvedSpec: `${packageName}@${scenario.initialVersion}`,
                  resolvedVersion: scenario.initialVersion,
                  integrity: "sha512-plugin-test",
                },
              },
            },
          },
          logger: { info: () => {}, warn: (message) => warnings.push(message) },
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        }),
    );
    expect(result.outcomes, JSON.stringify(result.outcomes)).toMatchObject([
      {
        pluginId,
        status: scenario.initialVersion === scenario.selectedVersion ? "unchanged" : "updated",
        currentVersion: scenario.initialVersion,
        nextVersion: scenario.selectedVersion,
      },
    ]);
    const record = result.config.plugins?.installs?.[pluginId];
    expect(record).toMatchObject({
      resolvedName: packageName,
      resolvedVersion: scenario.selectedVersion,
      integrity: "sha512-plugin-test",
    });
    assert(record?.installPath);
    expect(
      JSON.parse(fs.readFileSync(path.join(record.installPath, "package.json"), "utf8")),
    ).toMatchObject({ name: packageName, version: scenario.selectedVersion });
    const metadataCommands = runCommandWithTimeoutMock.mock.calls
      .map(([argv]) => npmCommandArgs(argv))
      .filter((args): args is string[] => args?.[0] === "view");
    expect(metadataCommands.filter((args) => args[2] === "versions")).toHaveLength(
      scenario.retry ? 2 : 1,
    );
    expect(
      metadataCommands.filter((args) => args[1] === `${packageName}@${scenario.selectedVersion}`),
    ).toHaveLength(scenario.initialVersion === scenario.selectedVersion ? 0 : 1);
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(true);
    expect(warnings.filter((message) => message.startsWith(`Resolved ${packageName} to `))).toEqual(
      [expect.stringContaining(scenario.warning)],
    );
  });

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
