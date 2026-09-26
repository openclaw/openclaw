import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { maybeRepairPluginRegistryState } from "../commands/doctor-plugin-registry.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { buildPluginInspectReport, buildPluginSnapshotReport } from "./status.js";

const defaultPluginId = "diagnostics-otel";
const defaultPackageName = `@openclaw/${defaultPluginId}`;
const agentMailIntegrity = normalizeClawHubSha256Integrity(
  "sha256:155221cec38673a39bc27629f9f6ec87567ce4e37b7fa619ec4b1f7ca3d28730",
);
if (!agentMailIntegrity) {
  throw new Error("Expected a valid AgentMail catalog integrity");
}

afterEach(() => {
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("recorded plugin trust diagnostics", () => {
  it.each([
    { name: "legacy npm spec", override: {}, reason: "trusted-official", trusted: true },
    {
      name: "legacy ClawHub spec",
      override: { source: "clawhub", spec: `clawhub:${defaultPackageName}@2026.8.2` },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
    },
    { name: "missing record", missing: true, reason: "record-missing", trusted: false },
    { name: "path install", override: { source: "path" }, reason: "origin-path", trusted: false },
    {
      name: "missing provenance",
      override: { spec: undefined },
      reason: "provenance-missing",
      trusted: false,
    },
    {
      name: "conflicting identity",
      override: { resolvedName: "@vendor/diffs" },
      reason: "provenance-invalid",
      trusted: false,
    },
    {
      name: "local npm archive",
      override: { artifactKind: "npm-pack" },
      reason: "origin-path",
      trusted: false,
    },
    {
      name: "official AgentMail ClawHub install",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: {
        source: "clawhub",
        spec: "clawhub:@agentmail/agentmail@0.2.1",
        clawhubPackage: "@agentmail/agentmail",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
      },
      reason: "trusted-official",
      trusted: true,
    },
    {
      name: "legacy AgentMail ClawHub install",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: { source: "clawhub", spec: "clawhub:@agentmail/agentmail@0.2.1" },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
      repairTrusted: false,
    },
    {
      name: "legacy AgentMail ClawHub install with matching integrity",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: {
        source: "clawhub",
        spec: "clawhub:@agentmail/agentmail@0.2.1",
        integrity: agentMailIntegrity,
      },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
      repairTrusted: true,
    },
    {
      name: "unendorsed AgentMail npm namesake",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      reason: "provenance-invalid",
      trusted: false,
    },
  ] satisfies Array<{
    name: string;
    pluginId?: string;
    packageName?: string;
    version?: string;
    override?: Partial<PluginInstallRecord>;
    missing?: boolean;
    reason: string;
    trusted: boolean;
    repair?: boolean;
    repairTrusted?: boolean;
  }>)(
    "inspection and registration agree for $name",
    async ({
      override,
      missing,
      reason,
      trusted,
      repair,
      repairTrusted,
      pluginId = defaultPluginId,
      packageName = defaultPackageName,
      version = "2026.8.2",
    }) => {
      useNoBundledPlugins();
      const stateDir = fs.realpathSync(makePluginLoaderTempDir());
      const plugin = writePlugin({
        id: pluginId,
        dir: path.join(stateDir, "extensions", pluginId),
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
          const blocked = [];
          try {
            api.runtime.state.openKeyedStore({ namespace: "proof", maxEntries: 2 });
          } catch (error) {
            blocked.push("openKeyedStore: " + String(error));
          }
          try {
            api.runtime.state.openChannelIngressQueue({ accountId: "default" });
          } catch (error) {
            blocked.push("openChannelIngressQueue: " + String(error));
          }
          if (blocked.length) throw new Error(blocked.join("; "));
        } };`,
      });
      writePluginMetadata({
        dir: plugin.dir,
        id: plugin.id,
        packageJson: {
          name: packageName,
          version,
          openclaw: { extensions: ["./index.cjs"] },
        },
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const install: PluginInstallRecord = {
          source: "npm",
          spec: `${packageName}@${version}`,
          installPath: plugin.dir,
          ...override,
        };
        refreshPersistedInstalledPluginIndex({
          reason: "source-changed",
          installRecords: missing ? {} : { [pluginId]: install },
        });
        const config = {
          plugins: {
            allow: [plugin.id],
            entries: { [plugin.id]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const snapshot = buildPluginSnapshotReport({ config });
        const inspected = buildPluginInspectReport({
          id: plugin.id,
          config,
          report: snapshot,
        })!.plugin;
        const registry = loadOpenClawPlugins({ config, cache: false });
        const loaded = registry.plugins.find((entry) => entry.id === plugin.id)!;
        expect(inspected.trustedOfficialInstall === true).toBe(trusted);
        expect(loaded.trustedOfficialInstall === true).toBe(trusted);
        expect(inspected.trust).toEqual(loaded.trust);
        expect(loaded.trust).toMatchObject({
          reason,
          registryPath: path.join(stateDir, "state", "openclaw.sqlite"),
          origin: "global",
        });
        expect(loaded.status).toBe(trusted ? "loaded" : "error");
        if (!trusted) {
          expect(loaded.error).toContain(
            "openKeyedStore is only available for trusted plugins in this release.",
          );
          expect(loaded.error).toContain(
            "openChannelIngressQueue is only available for trusted plugins in this release.",
          );
          expect(loaded.error).toContain(`loaded from ${JSON.stringify(plugin.file)}`);
          expect(loaded.error).toContain(`reason=${reason}`);
          expect(loaded.error).toContain(
            `registryPath=${JSON.stringify(path.join(stateDir, "state", "openclaw.sqlite"))}`,
          );
          expect(loaded.error).toContain(
            `installSource=${JSON.stringify(missing ? null : install.source)}`,
          );
          expect(loaded.error).toContain(
            `installSpec=${JSON.stringify(missing ? null : (install.spec ?? null))}`,
          );
        }
        if (repair) {
          await maybeRepairPluginRegistryState({
            config,
            stateDir,
            prompter: { shouldRepair: true },
          });
          const repaired = loadOpenClawPlugins({ config, cache: false }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          const inspectedAfter = buildPluginSnapshotReport({ config }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          expect(repaired).toMatchObject({
            status: repairTrusted === false ? "error" : "loaded",
            trust: { reason: repairTrusted === false ? reason : "trusted-official" },
          });
          expect(repaired.trustedOfficialInstall === true).toBe(repairTrusted !== false);
          expect(inspectedAfter.trust).toEqual(repaired.trust);
        }
      });
    },
  );
});
