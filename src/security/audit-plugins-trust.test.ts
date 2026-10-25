import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { collectPluginsTrustFindings } from "./audit-plugins-trust.js";

const mockChannelPlugins = vi.hoisted(() => [
  {
    id: "discord",
    capabilities: {},
    commands: {},
    config: { listAccountIds: () => [], resolveAccount: () => null },
  },
]);
const mockPluginRegistryIds = vi.hoisted(() => ["anthropic", "discord", "some-plugin"]);
const mockPluginTools = vi.hoisted(() => ({ names: ["some_plugin_tool"] as string[] | undefined }));

const readInstalledPackageVersionMock = vi.hoisted(() =>
  vi.fn(async (dir: string): Promise<string | undefined> => {
    if (dir.includes("/extensions/voice-call") || dir.includes("\\extensions\\voice-call")) {
      return "9.9.9";
    }
    if (dir.includes("/hooks/test-hooks") || dir.includes("\\hooks\\test-hooks")) {
      return "8.8.8";
    }
    return undefined;
  }),
);

vi.mock("../infra/package-update-utils.js", () => ({
  readInstalledPackageVersion: readInstalledPackageVersionMock,
}));

// mock-isolation: Use explicit fixture enablement without loading plugin runtime state.
vi.mock("../plugins/config-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/config-state.js")>()),
  normalizePluginsConfig: (config: OpenClawConfig["plugins"]) => ({
    allow: config?.allow ?? [],
    deny: config?.deny ?? [],
    enabled: config?.enabled !== false,
    entries: config?.entries ?? {},
  }),
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  createPluginRegistryIdNormalizer: () => (id: string) => id,
  loadPluginRegistrySnapshot: () => ({
    diagnostics: [],
    plugins: mockPluginRegistryIds.map((pluginId) => ({
      pluginId,
      contributions:
        pluginId === "some-plugin" && mockPluginTools.names !== undefined
          ? { contracts: { tools: mockPluginTools.names } }
          : undefined,
    })),
  }),
}));

// mock-isolation: Trust findings use fixture channels without loading installed channel runtimes.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfigAsync: async () => mockChannelPlugins,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => null,
}));

describe("security audit install metadata findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const audit = (cfg: OpenClawConfig, stateDir: string) =>
    collectPluginsTrustFindings({ cfg, stateDir });

  const writeHookInstalls = (
    stateDir: string,
    installs: Record<string, HookInstallRecord>,
  ): void => {
    writeConfigMachineState("hooks.internal.installs", installs, {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  };

  const requireInstallFinding = (findings: Awaited<ReturnType<typeof audit>>, checkId: string) =>
    expectDefined(
      findings.find((entry) => entry.checkId === checkId),
      checkId,
    );
  const npm = (spec: string, fields: Partial<HookInstallRecord> = {}): HookInstallRecord => ({
    source: "npm",
    spec,
    ...fields,
  });
  async function extensions(stateDir: string, names: string[]) {
    for (const name of names) {
      await fs.mkdir(path.join(stateDir, "extensions", name), { recursive: true });
    }
  }

  const writePluginIndexInstallRecords = async (
    stateDir: string,
    records: Record<string, PluginInstallRecord>,
  ) => {
    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "2026.4.25",
      compatRegistryVersion: "compat",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: Date.now(),
      installRecords: records,
      plugins: [],
      diagnostics: [],
    };
    await writePersistedInstalledPluginIndex(index, { stateDir });
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-install-"));
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
  });

  afterAll(async () => {
    // Fixture writers and audit readers share one SQLite owner; close it before removing files.
    await closeOpenClawStateDatabaseAsync();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("evaluates install metadata findings", async () => {
    for (const pinned of [false, true]) {
      const stateDir = await makeTmpDir(`pinned-${pinned}`);
      const record = (packageName: string, integrity: string) =>
        npm(`@openclaw/${packageName}${pinned ? "@1.2.3" : ""}`, {
          ...(pinned ? { integrity } : {}),
          resolvedSpec: `@openclaw/${packageName}@1.2.3`,
        });
      await writePluginIndexInstallRecords(stateDir, {
        "voice-call": record("voice-call", "sha512-plugin"),
      });
      writeHookInstalls(stateDir, { "test-hooks": record("test-hooks", "sha512-hook") });
      const findings = await audit({}, stateDir);
      for (const owner of ["plugins", "hooks"]) {
        for (const suffix of ["unpinned_npm_specs", "missing_integrity"]) {
          const finding = findings.find(({ checkId }) => checkId === `${owner}.installs_${suffix}`);
          if (pinned) {
            expect(finding).toBeUndefined();
          } else {
            expect(finding).toMatchObject({ severity: "warn" });
          }
        }
      }
    }
  });

  it("keeps install metadata precedence and reads hooks after plugin versions", async () => {
    const stateDir = await makeTmpDir("install-metadata-order");
    const pluginPath = path.join(stateDir, "custom-plugin");
    const hookPath = path.join(stateDir, "hooks", "test-hooks");
    await writePluginIndexInstallRecords(stateDir, {
      "voice-call": npm("@openclaw/voice-call", {
        installPath: pluginPath,
        version: "0.9.0",
        resolvedVersion: "1.0.0",
      }),
      "empty-version": npm("@openclaw/empty-version@1.0.0", {
        integrity: "sha512-empty",
        version: "1.0.0",
        resolvedVersion: "",
      }),
      "local-plugin": { source: "path", spec: "local-plugin", version: "1.0.0" },
    });
    writeHookInstalls(stateDir, {
      "old-hooks": npm("old-hooks", { version: "1.0.0" }),
    });

    const reads: string[] = [];
    await readInstalledPackageVersionMock.withImplementation(
      async (dir) => {
        reads.push(dir);
        if (dir === pluginPath) {
          writeHookInstalls(stateDir, {
            "test-hooks": npm("@openclaw/test-hooks", { integrity: " ", version: "2.0.0" }),
          });
          return "1.1.0";
        }
        return dir === hookPath ? "2.1.0" : undefined;
      },
      async () => {
        const findings = await audit({}, stateDir);
        // Persistence drops blank resolved versions and sorts plugin IDs before the audit reads them.
        expect(reads).toEqual([
          path.join(stateDir, "extensions", "empty-version"),
          pluginPath,
          hookPath,
        ]);
        expect(findings).toHaveLength(6);
        for (const [owner, id, recorded, installed] of [
          ["plugins", "voice-call", "1.0.0", "1.1.0"],
          ["hooks", "test-hooks", "2.0.0", "2.1.0"],
        ]) {
          for (const suffix of ["unpinned_npm_specs", "missing_integrity", "version_drift"]) {
            expect(requireInstallFinding(findings, `${owner}.installs_${suffix}`).detail).toContain(
              id,
            );
          }
          expect(
            requireInstallFinding(findings, `${owner}.installs_version_drift`).detail,
          ).toContain(`recorded ${recorded}, installed ${installed}`);
          for (const [suffix, guidance] of [
            ["unpinned_npm_specs", "@scope/pkg@1.2.3"],
            ["missing_integrity", `Reinstall or update ${owner}`],
            ["version_drift", `openclaw ${owner} update --all`],
          ]) {
            expect(
              requireInstallFinding(findings, `${owner}.installs_${suffix}`).remediation,
            ).toContain(guidance);
          }
        }
      },
    );
  });

  it("evaluates phantom allowlist findings", async () => {
    async function auditAllowlist(installed: string, allow: string[]) {
      const stateDir = await makeTmpDir("phantom");
      await extensions(stateDir, [installed]);
      return audit({ plugins: { allow } }, stateDir);
    }
    const bundledFindings = await auditAllowlist("some-installed-plugin", [
      "discord",
      "anthropic",
      "some-installed-plugin",
    ]);
    expect(
      bundledFindings.find((finding) => finding.checkId === "plugins.allow_phantom_entries"),
    ).toBeUndefined();

    const reportedFindings = await auditAllowlist("installed-plugin", [
      "installed-plugin",
      "ghost-plugin-xyz",
    ]);
    const phantomFinding = requireInstallFinding(reportedFindings, "plugins.allow_phantom_entries");
    expect(phantomFinding.severity).toBe("warn");
    expect(phantomFinding.detail).toContain("ghost-plugin-xyz");
    expect(phantomFinding.detail).not.toContain("installed-plugin");
  });

  it("ignores install backup and debris dirs when auditing installed plugin roots", async () => {
    const stateDir = await makeTmpDir("installed-plugin-debris");
    await extensions(stateDir, [
      "live-plugin",
      ".openclaw-install-backups",
      "node_modules",
      "old-plugin.backup-20260502",
      "old-plugin.disabled.20260502",
      "old-plugin.bak",
    ]);

    const findings = await audit({}, stateDir);

    const noAllowlist = requireInstallFinding(findings, "plugins.extensions_no_allowlist");
    expect(noAllowlist.detail).toContain("Found 1 extension(s)");

    const toolsReachable = requireInstallFinding(
      findings,
      "plugins.tools_reachable_permissive_policy",
    );
    expect(toolsReachable.detail).toContain("Enabled extension plugins: live-plugin.");
    expect(findings.map((finding) => finding.detail).join("\n")).not.toContain(
      ".openclaw-install-backups",
    );
  });
});

describe("security audit extension tool reachability findings", () => {
  it("evaluates extension tool reachability findings", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-extensions-"));
    const home = path.join(fixtureRoot, "home");
    const stateDir = path.join(fixtureRoot, "shared-extensions-state");
    const isolatedEnv = createPathResolutionEnv(home, { OPENCLAW_HOME: home });
    const scopedEnv = Object.fromEntries(
      [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
      ].map((key) => [key, isolatedEnv[key]]),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(stateDir, "extensions", "some-plugin"), {
        recursive: true,
        mode: 0o700,
      });
      await withEnvAsync(scopedEnv, async () => {
        const reachable = "plugins.tools_reachable_permissive_policy";
        const declared = ["some_plugin_tool"];
        const allowed: OpenClawConfig = { plugins: { allow: ["some-plugin"] } };
        const grouped: OpenClawConfig = {
          ...allowed,
          tools: { profile: "coding", alsoAllow: ["group:plugins"] },
        };
        const cases: Array<
          [string, OpenClawConfig, string[] | undefined, string | false, string?]
        > = [
          ["no allowlist", {}, declared, "plugins.extensions_no_allowlist"],
          ["permissive", allowed, declared, reachable],
          [
            "agent scope",
            { ...allowed, agents: { entries: { ops: { tools: { profile: "full" } } } } },
            declared,
            reachable,
            "- agents.entries.ops",
          ],
          ["restrictive", { ...allowed, tools: { profile: "coding" } }, declared, false],
          ["plugin group", grouped, declared, reachable],
          ["missing contract", grouped, undefined, reachable],
          ["empty contract", allowed, [], false],
          [
            "concrete deny",
            { ...grouped, tools: { ...grouped.tools, deny: declared } },
            declared,
            false,
          ],
        ];
        for (const [name, cfg, tools, checkId, detail] of cases) {
          mockPluginTools.names = tools;
          const findings = await collectPluginsTrustFindings({ cfg, stateDir });
          if (checkId) {
            expect(findings, name).toContainEqual(
              expect.objectContaining({ checkId, severity: "warn" }),
            );
          } else {
            expect(
              findings.some((entry) => entry.checkId === reachable),
              name,
            ).toBe(false);
          }
          if (detail) {
            expect(findings.find((entry) => entry.checkId === reachable)?.detail).toContain(detail);
          }
        }
      });
    } finally {
      homedirSpy.mockRestore();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
