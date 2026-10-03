import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, it, vi, type Mock } from "vitest";
import type { runCommandWithTimeout } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import {
  expectIntegrityDriftRejected,
  mockNpmViewMetadataResult,
} from "../test-utils/npm-spec-install-test-helpers.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";

type NpmFixturePackage = {
  spec: string;
  npmRoot: string;
  packageName: string;
  version: string;
  pluginId?: string;
  expectedDependencySpec?: string;
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
  it("resolves a changed attempt instead of reusing another spec's metadata", async () => {
    const spec = "metadata-attempt@2.0.0";
    const npmRoot = getNpmRoot();
    mockNpmViewAndInstallMany([
      { spec, npmRoot, packageName: "metadata-attempt", version: "2.0.0" },
    ]);
    const result = await installPluginFromNpmSpec({
      spec,
      npmMetadata: {
        spec: "metadata-attempt@1.0.0",
        metadata: { name: "metadata-attempt", version: "1.0.0" },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      version: "2.0.0",
      npmResolution: { name: "metadata-attempt", version: "2.0.0" },
    });
  });

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

  it.each(["fetched", "prepared"])("checks integrity with %s npm metadata", async (source) => {
    mockNpmViewMetadataResult(runCommandWithTimeoutMock, {
      name: "@openclaw/voice-call",
      version: "0.0.1",
      integrity: "sha512-new",
      shasum: "newshasum",
    });

    const onIntegrityDrift = vi.fn(async () => false);
    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call@0.0.1",
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      ...(source === "prepared"
        ? {
            npmMetadata: {
              spec: "@openclaw/voice-call@0.0.1",
              metadata: {
                name: "@openclaw/voice-call",
                version: "0.0.1",
                integrity: "sha512-new",
                shasum: "newshasum",
              },
            },
          }
        : {}),
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
