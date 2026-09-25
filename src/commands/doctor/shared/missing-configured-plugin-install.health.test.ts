// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";

const { mocks, testEnv, tempDirs, setupPluginInstallSuite } =
  await import("./missing-configured-plugin-install.suite.test-support.js");

describe("configured plugin install health findings", () => {
  setupPluginInstallSuite();

  it("maps a missing beta-channel plugin to a structured finding and dry-run effect offline", async () => {
    mocks.resolveNpmSpecMetadata.mockImplementation(() => {
      throw new Error("Health detection must not query the npm registry.");
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix",
          expectedIntegrity: "sha512-test",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        update: { channel: "beta" },
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: testEnv,
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "missing-install-record",
      pluginId: "matrix",
      installSpec: "@openclaw/plugin-matrix",
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      target: "matrix",
      fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix.",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-install-configured-plugin",
      target: "matrix",
      dryRunSafe: false,
    });
  });

  it("maps package-update deferrals to structured findings without installing packages", async () => {
    const missingDiscordPath = path.resolve("/missing/discord");
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: missingDiscordPath,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        ...testEnv,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "deferred-package-manager-repair",
      pluginId: "discord",
      installPath: missingDiscordPath,
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      path: missingDiscordPath,
      target: "discord",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-defer-configured-plugin-install-repair",
      target: "discord",
      dryRunSafe: true,
    });
  });

  it.each([
    {
      name: "resolved selector takes precedence",
      source: "clawhub",
      spec: "clawhub:demo@latest",
      resolvedSpec: "clawhub:demo@1.2.3",
      installSpec: "clawhub:demo@1.2.3",
      fixHint:
        "Run `openclaw plugins install clawhub:demo@1.2.3 --force` to reinstall the configured plugin package.",
    },
    {
      name: "resolved selector without original spec",
      source: "clawhub",
      resolvedSpec: "clawhub:demo@1.2.3",
      installSpec: "clawhub:demo@1.2.3",
      fixHint:
        "Run `openclaw plugins install clawhub:demo@1.2.3 --force` to reinstall the configured plugin package.",
    },
    {
      name: "original selector only",
      source: "npm",
      spec: "@example/demo@1.2.3",
      installSpec: "@example/demo@1.2.3",
      fixHint:
        "Run `openclaw plugins install @example/demo@1.2.3 --force` to reinstall the configured plugin package.",
    },
    {
      name: "no recorded selector",
      source: "clawhub",
      installSpec: undefined,
      fixHint:
        "Run `openclaw doctor --fix` to repair the configured plugin install. An exact reinstall command is unavailable because the install record has no package spec.",
    },
  ])("preserves install identity for an empty project: $name", async (fixture) => {
    const installPath = tempDirs.make("openclaw-doctor-empty-plugin-");
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: fixture.source,
        spec: fixture.spec,
        resolvedSpec: fixture.resolvedSpec,
        installPath,
        resolvedName: "demo",
        resolvedVersion: "1.2.3",
      },
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "demo",
        pluginId: "demo",
        meta: { label: "Demo" },
        install: { npmSpec: "@example/catalog-demo" },
      },
    ]);

    const {
      detectConfiguredPluginInstallHealthIssues,
      configuredPluginInstallIssueToHealthFinding,
    } = await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: { entries: { demo: { enabled: true } } },
        channels: { demo: { enabled: true } },
      },
      env: testEnv,
    });

    expect(
      configuredPluginInstallIssueToHealthFinding(
        expectDefined(issues[0], "missing payload issue"),
      ),
    ).toMatchObject({ target: "demo", source: fixture.source, fixHint: fixture.fixHint });
    expect(issues).toEqual([
      {
        kind: "missing-installed-payload",
        pluginId: "demo",
        installPath,
        installSpec: fixture.installSpec,
        installSource: fixture.source,
      },
    ]);
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
  });
});
