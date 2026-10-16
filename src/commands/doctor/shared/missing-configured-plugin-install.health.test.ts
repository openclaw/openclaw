// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { channelPluginEntry } from "./missing-configured-plugin-install.test-helpers.js";

const { mocks, testEnv, tempDirs, setupPluginInstallSuite } =
  await import("./missing-configured-plugin-install.suite.test-support.js");
const {
  configuredPluginInstallIssueToHealthFinding,
  configuredPluginInstallIssueToRepairEffect,
  detectConfiguredPluginInstallHealthIssues,
} = await import("./missing-configured-plugin-install.js");

describe("configured plugin install health findings", () => {
  setupPluginInstallSuite();

  it.each([false, true])(
    "reports install health without mutation (deferred=%s)",
    async (deferred) => {
      const pluginId = deferred ? "discord" : "matrix";
      const npmSpec = deferred ? "@openclaw/discord" : "@openclaw/plugin-matrix";
      const installPath = path.resolve("/missing/discord");
      mocks.resolveNpmSpecMetadata.mockImplementation(() => {
        throw new Error("Health detection must not query the npm registry.");
      });
      if (deferred) {
        mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
          discord: { source: "npm", spec: npmSpec, installPath },
        });
      }
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        deferred
          ? channelPluginEntry({ id: pluginId, label: "Discord", npmSpec })
          : {
              id: pluginId,
              pluginId,
              meta: { label: "Matrix" },
              install: { npmSpec, expectedIntegrity: "sha512-test" },
              trustedSourceLinkedOfficialInstall: true,
            },
      ]);
      const [issue] = await detectConfiguredPluginInstallHealthIssues({
        cfg: deferred
          ? {
              plugins: { entries: { discord: { enabled: true } } },
              channels: { discord: { enabled: true } },
            }
          : {
              update: { channel: "beta" },
              channels: { matrix: { enabled: true, homeserver: "https://matrix.example.org" } },
            },
        env: deferred
          ? {
              ...testEnv,
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
            }
          : testEnv,
      });

      expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
      expect(
        mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
      ).not.toHaveBeenCalled();
      expect(issue).toEqual(
        deferred
          ? { kind: "deferred-package-manager-repair", pluginId, installPath }
          : { kind: "missing-install-record", pluginId, installSpec: npmSpec },
      );
      const finding = configuredPluginInstallIssueToHealthFinding(
        expectDefined(issue, "health issue"),
      );
      expect(finding).toMatchObject({
        checkId: "core/doctor/configured-plugin-installs",
        severity: "warning",
        target: pluginId,
        ...(deferred
          ? { path: installPath }
          : { fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix." }),
      });
      expect(
        configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
      ).toEqual({
        kind: "package",
        action: deferred
          ? "would-defer-configured-plugin-install-repair"
          : "would-install-configured-plugin",
        target: pluginId,
        dryRunSafe: deferred,
      });
    },
  );

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
      channelPluginEntry({ id: "demo", label: "Demo", npmSpec: "@example/catalog-demo" }),
    ]);

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
