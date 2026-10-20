// Covers plugin trust audit findings and remediation hints.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const mockPluginRegistryIds = vi.hoisted(() => [
  "active-memory",
  "anthropic",
  "brave",
  "discord",
  "google",
  "lmstudio",
  "memory-core",
  "ollama",
]);

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

type FixturePluginsConfig = {
  enabled?: boolean;
  deny?: string[];
  allow?: string[];
  entries?: Record<string, { enabled?: boolean }>;
};

// mock-isolation: Use explicit fixture enablement without loading plugin runtime state.
vi.mock("../plugins/config-state.js", () => ({
  normalizePluginId: (id: string) => id,
  resolveEffectiveEnableState: (params: {
    config?: FixturePluginsConfig;
    id: string;
    enabledByDefault?: boolean;
  }) => {
    const entry = params.config?.entries?.[params.id];
    const denied = params.config?.deny?.includes(params.id) === true;
    const allowed =
      !params.config?.allow?.length ||
      params.config.allow.includes(params.id) ||
      params.config.allow.includes("group:plugins");
    const enabled =
      params.config?.enabled !== false &&
      !denied &&
      allowed &&
      entry?.enabled !== false &&
      (entry?.enabled === true || params.enabledByDefault === true);
    return { enabled, activated: enabled, reason: enabled ? "enabled" : "disabled" };
  },
  normalizePluginsConfig: (config: FixturePluginsConfig | undefined) => ({
    allow: config?.allow ?? [],
    deny: config?.deny ?? [],
    enabled: config?.enabled !== false,
    entries: config?.entries ?? {},
  }),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  createPluginRegistryIdNormalizer: () => (id: string) => id,
  loadPluginRegistrySnapshot: () => ({
    diagnostics: [],
    plugins: mockPluginRegistryIds.map((pluginId) => ({ pluginId })),
  }),
}));

vi.mock("../config/commands.js", () => ({
  resolveNativeSkillsEnabled: ({
    globalSetting,
    providerSetting,
  }: {
    globalSetting?: boolean | "auto";
    providerSetting?: boolean | "auto";
  }) => providerSetting === true || (providerSetting === undefined && globalSetting === true),
}));

// mock-isolation: Trust findings use fixture channels without loading installed channel runtimes.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfigAsync: async () => mockChannelPlugins,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => null,
}));

vi.mock("../agents/sandbox/config.js", () => ({
  resolveSandboxConfigForAgent: () => ({ mode: "off" }),
}));

vi.mock("../agents/sandbox/tool-policy.js", () => ({
  resolveSandboxToolPolicyForAgent: () => undefined,
}));

vi.mock("../agents/tool-policy-match.js", () => ({
  isToolAllowedByPolicies: (_tool: string, policies: unknown[]) =>
    policies.every((policy) => policy == null),
}));

vi.mock("../agents/tool-policy.js", () => ({
  resolveToolProfilePolicy: (profile: unknown) =>
    profile === "coding" || profile === "minimal" ? {} : undefined,
}));

vi.mock("../agents/sandbox-tool-policy.js", () => ({
  pickSandboxToolPolicy: () => undefined,
}));

describe("security audit install metadata findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const runInstallMetadataAudit = async (cfg: OpenClawConfig, stateDir: string) => {
    return await collectPluginsTrustFindings({ cfg, stateDir });
  };

  const writeHookInstalls = (
    stateDir: string,
    installs: Record<string, HookInstallRecord>,
  ): void => {
    writeConfigMachineState("hooks.internal.installs", installs, {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  };

  const requireInstallFinding = (
    findings: Awaited<ReturnType<typeof runInstallMetadataAudit>>,
    checkId: string,
  ) => {
    const finding = findings.find((entry) => entry.checkId === checkId);
    if (!finding) {
      throw new Error(`Expected ${checkId} finding`);
    }
    return finding;
  };

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
      plugins: Object.keys(records).map((pluginId) => ({
        pluginId,
        manifestPath: path.join(stateDir, "extensions", pluginId, "openclaw.plugin.json"),
        manifestHash: "manifest",
        rootDir: path.join(stateDir, "extensions", pluginId),
        origin: "global" as const,
        enabled: true,
        startup: { sidecar: true, memory: false, agentHarnesses: [] },
        compat: [],
      })),
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
    type Flags = Partial<Record<"pinned" | "integrity" | "resolved" | "drift", boolean>>;
    const cases: Array<[string, Flags, string[], string[]]> = [
      ["unpinned", {}, ["unpinned_npm_specs", "missing_integrity"], []],
      [
        "pinned",
        { pinned: true, integrity: true },
        [],
        ["unpinned_npm_specs", "missing_integrity"],
      ],
      [
        "unpinned with resolved metadata",
        { integrity: true, resolved: true },
        ["unpinned_npm_specs"],
        ["missing_integrity"],
      ],
      ["version drift", { pinned: true, integrity: true, drift: true }, ["version_drift"], []],
    ];
    for (const [name, flags, present, absent] of cases) {
      const stateDir = await makeTmpDir(name);
      const record = (packageName: string, integrity: string): HookInstallRecord => ({
        source: "npm",
        spec: `@openclaw/${packageName}${flags.pinned ? "@1.2.3" : ""}`,
        ...(flags.integrity ? { integrity } : {}),
        ...(flags.resolved ? { resolvedSpec: `@openclaw/${packageName}@1.2.3` } : {}),
        ...(flags.drift ? { resolvedVersion: "1.2.3" } : {}),
      });
      await writePluginIndexInstallRecords(stateDir, {
        "voice-call": record("voice-call", "sha512-plugin"),
      });
      writeHookInstalls(stateDir, { "test-hooks": record("test-hooks", "sha512-hook") });
      const findings = await runInstallMetadataAudit({}, stateDir);
      for (const owner of ["plugins", "hooks"]) {
        for (const suffix of present) {
          expect(findings, name).toContainEqual(
            expect.objectContaining({ checkId: `${owner}.installs_${suffix}`, severity: "warn" }),
          );
        }
        for (const suffix of absent) {
          expect(
            findings.some(({ checkId }) => checkId === `${owner}.installs_${suffix}`),
            name,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps install metadata precedence and reads hooks after plugin versions", async () => {
    const stateDir = await makeTmpDir("install-metadata-order");
    const pluginPath = path.join(stateDir, "custom-plugin");
    const hookPath = path.join(stateDir, "hooks", "test-hooks");
    await writePluginIndexInstallRecords(stateDir, {
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: pluginPath,
        version: "0.9.0",
        resolvedVersion: "1.0.0",
      },
      "empty-version": {
        source: "npm",
        spec: "@openclaw/empty-version@1.0.0",
        integrity: "sha512-empty",
        version: "1.0.0",
        resolvedVersion: "",
      },
      "local-plugin": { source: "path", spec: "local-plugin", version: "1.0.0" },
    });
    writeHookInstalls(stateDir, {
      "old-hooks": { source: "npm", spec: "old-hooks", version: "1.0.0" },
    });

    const reads: string[] = [];
    await readInstalledPackageVersionMock.withImplementation(
      async (dir) => {
        reads.push(dir);
        if (dir === pluginPath) {
          writeHookInstalls(stateDir, {
            "test-hooks": {
              source: "npm",
              spec: "@openclaw/test-hooks",
              integrity: " ",
              version: "2.0.0",
            },
          });
          return "1.1.0";
        }
        return dir === hookPath ? "2.1.0" : undefined;
      },
      async () => {
        const findings = await runInstallMetadataAudit({}, stateDir);
        // Persistence drops blank resolved versions and sorts plugin IDs before the audit reads them.
        expect(reads).toEqual([
          path.join(stateDir, "extensions", "empty-version"),
          pluginPath,
          hookPath,
        ]);
        expect(findings.map(({ checkId }) => checkId)).toEqual(
          ["plugins", "hooks"].flatMap((owner) =>
            ["unpinned_npm_specs", "missing_integrity", "version_drift"].map(
              (suffix) => `${owner}.installs_${suffix}`,
            ),
          ),
        );
        expect(findings.map(({ detail }) => detail)).toEqual([
          "Unpinned plugin index install records:\n- voice-call (@openclaw/voice-call)",
          "Plugin index records missing integrity:\n- voice-call",
          "Detected plugin install metadata drift:\n- voice-call (recorded 1.0.0, installed 1.1.0)",
          "Unpinned hook install records:\n- test-hooks (@openclaw/test-hooks)",
          "Hook install records missing integrity:\n- test-hooks",
          "Detected hook install metadata drift:\n- test-hooks (recorded 2.0.0, installed 2.1.0)",
        ]);
        expect(findings.map(({ remediation }) => remediation)).toEqual([
          "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
          "Reinstall or update plugins to refresh install metadata with resolved integrity hashes.",
          "Run `openclaw plugins update --all` (or reinstall affected plugins) to refresh install metadata.",
          "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
          "Reinstall or update hooks to refresh install metadata with resolved integrity hashes.",
          "Run `openclaw hooks update --all` (or reinstall affected hooks) to refresh install metadata.",
        ]);
      },
    );
  });

  it("evaluates phantom allowlist findings", async () => {
    const bundledStateDir = await makeTmpDir("phantom-bundled-excluded");
    await fs.mkdir(path.join(bundledStateDir, "extensions", "some-installed-plugin"), {
      recursive: true,
    });

    const bundledFindings = await runInstallMetadataAudit(
      {
        plugins: { allow: ["discord", "anthropic", "some-installed-plugin"] },
      },
      bundledStateDir,
    );
    expect(
      bundledFindings.find((finding) => finding.checkId === "plugins.allow_phantom_entries"),
    ).toBeUndefined();

    const reportedStateDir = await makeTmpDir("phantom-reported");
    await fs.mkdir(path.join(reportedStateDir, "extensions", "installed-plugin"), {
      recursive: true,
    });

    const reportedFindings = await runInstallMetadataAudit(
      {
        plugins: { allow: ["installed-plugin", "ghost-plugin-xyz"] },
      },
      reportedStateDir,
    );
    const phantomFinding = requireInstallFinding(reportedFindings, "plugins.allow_phantom_entries");
    expect(phantomFinding.severity).toBe("warn");
    expect(phantomFinding.detail).toContain("ghost-plugin-xyz");
    expect(phantomFinding.detail).not.toContain("installed-plugin");
  });

  it("ignores install backup and debris dirs when auditing installed plugin roots", async () => {
    const stateDir = await makeTmpDir("installed-plugin-debris");
    for (const name of [
      "live-plugin",
      ".openclaw-install-backups",
      "node_modules",
      "old-plugin.backup-20260502",
      "old-plugin.disabled.20260502",
      "old-plugin.bak",
    ]) {
      await fs.mkdir(path.join(stateDir, "extensions", name), { recursive: true });
    }

    const findings = await runInstallMetadataAudit({}, stateDir);

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
        const cases = [
          {
            name: "flags extensions without plugins.allow",
            cfg: {} satisfies OpenClawConfig,
            present: { checkId: "plugins.extensions_no_allowlist", severity: "warn" },
          },
          {
            name: "flags enabled extensions when tool policy can expose plugin tools",
            cfg: {
              plugins: { allow: ["some-plugin"] },
            } satisfies OpenClawConfig,
            present: { checkId: "plugins.tools_reachable_permissive_policy", severity: "warn" },
          },
          {
            name: "reports canonical agent paths for permissive tool policy",
            cfg: {
              plugins: { allow: ["some-plugin"] },
              agents: { entries: { ops: { tools: { profile: "full" } } } },
            } satisfies OpenClawConfig,
            detail: "- agents.entries.ops",
          },
          {
            name: "does not flag plugin tool reachability when profile is restrictive",
            cfg: {
              plugins: { allow: ["some-plugin"] },
              tools: { profile: "coding" },
            } satisfies OpenClawConfig,
            absent: "plugins.tools_reachable_permissive_policy",
          },
        ] as const;

        for (const testCase of cases) {
          const findings = await collectPluginsTrustFindings({ cfg: testCase.cfg, stateDir });
          if ("present" in testCase) {
            expect(findings).toContainEqual(expect.objectContaining(testCase.present));
          }
          if ("detail" in testCase) {
            expect(
              findings.find(
                (entry) => entry.checkId === "plugins.tools_reachable_permissive_policy",
              )?.detail,
            ).toContain(testCase.detail);
          }
          if ("absent" in testCase) {
            expect(findings.some((entry) => entry.checkId === testCase.absent)).toBe(false);
          }
        }
      });
    } finally {
      homedirSpy.mockRestore();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
