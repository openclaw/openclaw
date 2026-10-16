import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  managedRoots: vi.fn(),
  repairBundled: vi.fn(),
  repairInstalls:
    vi.fn<
      typeof import("./missing-configured-plugin-install.js").repairMissingConfiguredPluginInstalls
    >(),
  relinkPeers: vi.fn(),
  smokeCheck: vi.fn(),
}));

vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairInstalls,
}));
vi.mock("../../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: mocks.repairBundled,
}));
vi.mock("../../../plugins/plugin-peer-link.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/plugin-peer-link.js")>();
  return {
    ...actual,
    relinkOpenClawPeerDependenciesInManagedNpmRoot: mocks.relinkPeers,
  };
});
vi.mock("../../../plugins/npm-project-roots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/npm-project-roots.js")>();
  return { ...actual, listManagedPluginNpmRoots: mocks.managedRoots };
});
vi.mock("../../../plugins/payload-verification.js", () => ({
  runPluginPayloadSmokeCheck: mocks.smokeCheck,
}));

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { resolvePluginNpmGenerationProjectDir } from "../../../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync,
} from "../../../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { VERSION } from "../../../version.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

function repairResult(
  records: Record<string, PluginInstallRecord> = {},
  extra: Partial<Awaited<ReturnType<typeof mocks.repairInstalls>>> = {},
) {
  return { changes: [], warnings: [], records, ...extra };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const peerResult = { checked: 0, attempted: 0, repaired: 0, skipped: 0 };

function reportPackageReadFailure(
  packageDir: string,
  error = new Error("EACCES: permission denied"),
) {
  mocks.relinkPeers.mockImplementation(
    async (params: { onPackageReadError?: (error: unknown, packageDir: string) => void }) => {
      params.onPackageReadError?.(error, packageDir);
      return { ...peerResult, skipped: 1 };
    },
  );
}

async function expectHostVersion(compatibilityHostVersion?: string) {
  const cfg: OpenClawConfig = { plugins: { entries: {} } };
  await runPostCorePluginConvergence({
    cfg,
    compatibilityHostVersion,
    env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.12" },
  });
  expect(mocks.repairInstalls).toHaveBeenCalledWith({
    cfg,
    repairVersionDrift: false,
    env: {
      OPENCLAW_COMPATIBILITY_HOST_VERSION: compatibilityHostVersion ?? VERSION,
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
    },
    onWarning: expect.any(Function),
    beforePersistentEffect: expect.any(Function),
  });
}

describe("runPostCorePluginConvergence", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managedRoots.mockImplementation((npmRoot: string) => Promise.resolve([npmRoot]));
    mocks.repairBundled.mockReturnValue(null);
    mocks.repairInstalls.mockResolvedValue(repairResult());
    mocks.relinkPeers.mockResolvedValue(peerResult);
    mocks.smokeCheck.mockResolvedValue({ checked: [], failures: [] });
  });

  function writeBundledPlugin(
    rootDir: string,
    pluginId: string,
    version = "2026.5.20-beta.1",
  ): string {
    const pluginDir = path.join(rootDir, pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: pluginId,
      name: pluginId,
      version,
      configSchema: { type: "object" },
    });
    writeJson(path.join(pluginDir, "package.json"), { name: `@openclaw/${pluginId}`, version });
    return pluginDir;
  }

  it.each(["authority", "filesystem"] as const)(
    "joins admitted peer repairs before reporting a %s failure",
    async (kind) => {
      const firstStarted = createDeferred();
      const secondStarted = createDeferred();
      const releaseSibling = createDeferred();
      const refusal = new Error("one-shot peer repair refusal");
      const laterWrite = vi.fn();
      let refuse = false;
      let completed = false;
      let siblingSettled = false;
      mocks.managedRoots.mockResolvedValue(["first-root", "second-root"]);
      mocks.relinkPeers.mockImplementation(
        async (params: { npmRoot: string; beforePersistentApply?: () => void }) => {
          if (params.npmRoot === "first-root") {
            await secondStarted.promise;
            refuse = kind === "authority";
            try {
              params.beforePersistentApply?.();
              throw refusal;
            } finally {
              firstStarted.resolve();
            }
          }
          secondStarted.resolve();
          try {
            await releaseSibling.promise;
            params.beforePersistentApply?.();
            laterWrite();
            return { checked: 1, attempted: 1, repaired: 1, skipped: 0 };
          } finally {
            siblingSettled = true;
          }
        },
      );
      const operation = runPostCorePluginConvergence({
        cfg: { plugins: { enabled: false } },
        env: {},
        beforePersistentEffect: () => {
          if (refuse) {
            refuse = false;
            throw refusal;
          }
        },
      })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          completed = true;
        });
      try {
        await firstStarted.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        expect(mocks.smokeCheck).not.toHaveBeenCalled();
      } finally {
        releaseSibling.resolve();
        await operation;
      }
      const result = await operation;
      expect(siblingSettled).toBe(true);
      if (kind === "authority") {
        expect("error" in result).toBe(true);
        if (!("error" in result)) {
          throw new Error("Expected authority refusal");
        }
        expect(result.error).toBe(refusal);
        expect(laterWrite).not.toHaveBeenCalled();
        expect(mocks.smokeCheck).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          value: {
            warnings: [
              expect.objectContaining({ message: expect.stringContaining(refusal.message) }),
            ],
          },
        });
        expect(laterWrite).toHaveBeenCalledOnce();
        expect(mocks.smokeCheck).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses the candidate runtime version over a stale inherited host version", async () => {
    await expectHostVersion();
  });

  it("uses an explicit compatibility host version for startup convergence", async () => {
    await expectHostVersion("2026.7.2-beta.7");
  });

  it("returns ok when no warnings/failures and includes repair changes", async () => {
    mocks.repairInstalls.mockResolvedValue(
      repairResult(
        { discord: { source: "npm", installPath: "/p/discord" } },
        {
          changes: ['Repaired missing configured plugin "discord".'],
          repairedPluginIds: ["discord"],
        },
      ),
    );
    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { discord: { enabled: true } } } } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.changes).toEqual(['Repaired missing configured plugin "discord".']);
    expect(result.repairedPluginIds).toEqual(["discord"]);
    expect(result.warnings).toEqual([]);
  });

  it("repairs managed npm openclaw peer links in every managed npm project before payload smoke checks", async () => {
    const stateDir = tempDirs.make("openclaw-post-core-convergence-");
    mocks.repairInstalls.mockResolvedValue(
      repairResult({ codex: { source: "npm", installPath: "/p/codex" } }),
    );
    mocks.managedRoots.mockResolvedValue([
      path.join(stateDir, "npm"),
      path.join(stateDir, "npm", "projects", "codex"),
    ]);
    mocks.relinkPeers
      .mockResolvedValueOnce(peerResult)
      .mockResolvedValueOnce({ checked: 1, attempted: 1, repaired: 1, skipped: 0 });

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { codex: { enabled: true } } } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    [path.join(stateDir, "npm"), path.join(stateDir, "npm", "projects", "codex")].forEach(
      (npmRoot, index) => {
        expect(mocks.relinkPeers).toHaveBeenNthCalledWith(index + 1, {
          npmRoot,
          logger: {},
          onPackageReadError: expect.any(Function),
          beforePersistentApply: expect.any(Function),
        });
      },
    );
    expect(result.changes).toEqual([
      "Repaired OpenClaw host peer link(s) for 1 managed npm plugin package(s).",
    ]);
    expect(mocks.relinkPeers.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        mocks.smokeCheck.mock.invocationCallOrder[0],
        "mocks.smokeCheck.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it.each(["peerDependencies", "dependencies"] as const)(
    "repairs a registered extensions-root %s stale host before the real payload smoke check",
    async (dependencyField) => {
      const stateDir = tempDirs.make("openclaw-post-core-convergence-");
      const packageDir = path.join(stateDir, "extensions", "email");
      const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
      fs.mkdirSync(staleHostDir, { recursive: true });
      writeJson(path.join(packageDir, "package.json"), {
        name: "@clawemail/email",
        version: "2026.7.1",
        [dependencyField]: { openclaw: ">=2026.7.1" },
        openclaw: { extensions: ["./index.js"] },
      });
      fs.writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
      writeJson(path.join(staleHostDir, "package.json"), {
        name: "openclaw",
        version: "2026.7.1-beta.2",
      });
      const records = { email: { source: "npm" as const, installPath: packageDir } };
      mocks.repairInstalls.mockResolvedValue(repairResult(records));
      mocks.smokeCheck.mockImplementation(async (params) => {
        const actual = await vi.importActual<
          typeof import("../../../plugins/payload-verification.js")
        >("../../../plugins/payload-verification.js");
        return await actual.runPluginPayloadSmokeCheck(params);
      });

      const result = await runPostCorePluginConvergence({
        cfg: { plugins: { entries: { email: { enabled: true } } } },
        env: { OPENCLAW_STATE_DIR: stateDir },
        baselineInstallRecords: records,
      });

      expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
      expect(result.errored).toBe(false);
      expect(result.smokeFailures).toEqual([]);
    },
  );

  it("prunes stale local bundled plugin shadows from baseline records before repair", async () => {
    const bundledRoot = tempDirs.make("openclaw-post-core-convergence-");
    writeBundledPlugin(bundledRoot, "discord");
    const baseline = {
      discord: {
        source: "path" as const,
        installPath: path.join(
          tempDirs.make("openclaw-post-core-convergence-"),
          "dist",
          "extensions",
          "discord",
        ),
        version: "2026.5.4-beta.3",
      },
      brave: { source: "npm" as const, installPath: "/p/brave" },
    };
    mocks.repairInstalls.mockResolvedValue(repairResult({ brave: baseline.brave }));
    const cfg = {
      plugins: { entries: { discord: { enabled: true }, brave: { enabled: true } } },
    } as unknown as OpenClawConfig;

    const result = await runPostCorePluginConvergence({
      cfg,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
      },
      baselineInstallRecords: baseline,
    });

    expect(mocks.repairInstalls).toHaveBeenCalledWith({
      cfg,
      repairVersionDrift: false,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      baselineRecords: { brave: baseline.brave },
      onWarning: expect.any(Function),
      beforePersistentEffect: expect.any(Function),
    });
    expect(result.changes).toEqual([
      'Removed stale local bundled plugin install record "discord".',
    ]);
    expect(result.installRecords).toEqual({ brave: baseline.brave });
  });

  it("preserves repair attribution and leaves unclassified warnings unowned", async () => {
    const message =
      'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.';
    const unclassifiedMessage = 'Failed to read plugin "discord" inventory.';
    mocks.repairInstalls.mockImplementation(async ({ onWarning }) => {
      onWarning?.({ message, pluginId: "discord" });
      onWarning?.({ message: unclassifiedMessage });
      return repairResult({}, { warnings: [message, unclassifiedMessage] });
    });
    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { discord: { enabled: true } } } } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.warnings).toStrictEqual([
      {
        kind: "repair",
        pluginId: "discord",
        reason: message,
        message,
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
      {
        reason: unclassifiedMessage,
        message: unclassifiedMessage,
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
    ]);
  });

  it("blocks convergence when a missing plugin cannot activate without capability consent", async () => {
    const message = 'Plugin "consent-fixture" requires capability consent.';
    mocks.repairInstalls.mockImplementation(async ({ onWarning }) => {
      onWarning?.({ message, pluginId: "consent-fixture" });
      return {
        changes: [],
        warnings: [message],
        failedPluginIds: ["consent-fixture"],
        outcomes: [
          {
            pluginId: "consent-fixture",
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            message,
          },
        ],
        records: {},
      };
    });

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { "consent-fixture": { enabled: true } } } },
      env: {},
    });

    expect(result.errored).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ message: 'Plugin "consent-fixture" requires capability consent.' }),
    ]);
    expect(result.smokeFailures).toEqual([]);
    expect(result.installRecords).toEqual({});
  });

  it("surfaces repair notices without marking convergence errored", async () => {
    const notice =
      'ClawHub trust warning for "@openclaw/discord@1.2.3": ClawHub has not completed a fresh clean security check for this release. Status: security scan is pending. Review the package before enabling it.';
    mocks.repairInstalls.mockResolvedValue({
      changes: ['Installed missing configured plugin "discord".'],
      notices: [notice],
      warnings: [],
      records: { discord: { source: "clawhub", installPath: "/p/discord" } },
    });
    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { discord: { enabled: true } } } } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toStrictEqual([{ reason: notice, message: notice, guidance: [] }]);
  });

  it("flags errored=true when smoke check finds a missing install path", async () => {
    mocks.repairInstalls.mockResolvedValue(repairResult({ brave: { source: "npm" } }));
    mocks.smokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          reason: "missing-install-path",
          detail: "Install path is missing from the plugin install record.",
        },
      ],
    });
    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { brave: { enabled: true } } } } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(true);
    expect(result.warnings).toStrictEqual([
      {
        pluginId: "brave",
        reason: "missing-install-path: Install path is missing from the plugin install record.",
        kind: "load",
        message:
          'Plugin "brave" failed post-core payload smoke check (missing-install-path): Install path is missing from the plugin install record.',
        guidance: [
          "Run `openclaw update repair` to retry plugin repair.",
          "Run `openclaw plugins inspect brave --runtime --json` for details.",
        ],
      },
    ]);
  });

  it("keeps an active __proto__ record in smoke and package-path classification", async () => {
    const stateDir = tempDirs.make("openclaw-post-core-convergence-");
    const installPath = path.join(
      stateDir,
      "npm",
      "projects",
      "__proto__",
      "node_modules",
      "__proto__",
    );
    const record: PluginInstallRecord = { source: "npm", installPath };
    const records = Object.create(null) as Record<string, PluginInstallRecord>;
    Object.defineProperty(records, "__proto__", {
      configurable: true,
      enumerable: true,
      value: record,
      writable: true,
    });
    mocks.repairInstalls.mockResolvedValue(repairResult(records));
    reportPackageReadFailure(installPath);
    mocks.smokeCheck.mockImplementation(
      async (params: { records: Record<string, PluginInstallRecord> }) => {
        expect(Object.getPrototypeOf(params.records)).toBeNull();
        expect(Object.keys(params.records)).toEqual(["__proto__"]);
        expect(Object.getOwnPropertyDescriptor(params.records, "__proto__")?.value).toBe(record);
        return {
          checked: ["__proto__"],
          failures: [
            {
              pluginId: "__proto__",
              installPath,
              reason: "unreadable-package-json",
              detail: `Could not read package.json at ${installPath}/package.json: EACCES`,
            },
          ],
        };
      },
    );

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { enabled: true } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      pluginId: "__proto__",
      reason: expect.stringContaining("unreadable-package-json"),
      guidance: [
        `Fix file access for ${path.join(installPath, "package.json")} so it is readable by the user running OpenClaw. For EACCES or EPERM, correct its ownership or permissions; otherwise resolve the reported filesystem I/O error, then retry.`,
        "Run `openclaw plugins inspect __proto__ --runtime --json` for details.",
      ],
    });
    expect(result.errored).toBe(true);
  });

  it("does not promote an inactive package read error into an ownerless blocker", async () => {
    const stateDir = tempDirs.make("openclaw-post-core-convergence-");
    const installPath = path.join(stateDir, "npm", "projects", "brave", "node_modules", "brave");
    mocks.repairInstalls.mockResolvedValue(repairResult({ brave: { source: "npm", installPath } }));
    reportPackageReadFailure(
      installPath,
      new Error(`EACCES: permission denied, open '${installPath}/package.json'`),
    );

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { brave: { enabled: false } } } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(mocks.smokeCheck).toHaveBeenCalledWith({
      records: {},
      env: expect.any(Object),
    });
    expect(result.warnings).toEqual([]);
    expect(result.errored).toBe(false);
  });

  it("keeps an unowned package read error visible as a repair warning", async () => {
    const stateDir = tempDirs.make("openclaw-post-core-convergence-");
    const packageDir = path.join(stateDir, "npm", "node_modules", "untracked");
    reportPackageReadFailure(packageDir);

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: {} } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.warnings).toStrictEqual([
      {
        reason: "Failed to repair installed OpenClaw host peer links: EACCES: permission denied",
        message: "Failed to repair installed OpenClaw host peer links: EACCES: permission denied",
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
    ]);
    expect(result.errored).toBe(false);
  });

  it("retires payload and record state before repair across two starts", async () => {
    const stateDir = tempDirs.make("openclaw-post-core-convergence-");
    const bundledRoot = tempDirs.make("openclaw-post-core-bundled-");
    const cfg = {
      update: { channel: "beta" as const },
      plugins: { allow: ["bundleddemo"], entries: { bundleddemo: { enabled: true } } },
    };
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      VITEST: "true",
    };
    writeBundledPlugin(bundledRoot, "bundleddemo", VERSION);
    const npmRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName: "@openclaw/bundleddemo",
      generationKey: "@openclaw/bundleddemo@2026.7.2-beta.7",
    });
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "bundleddemo");
    fs.mkdirSync(packageDir, { recursive: true });
    writeJson(path.join(npmRoot, "package.json"), {
      dependencies: { "@openclaw/bundleddemo": "2026.7.2-beta.7" },
    });
    writeJson(path.join(packageDir, "package.json"), {
      name: "@openclaw/bundleddemo",
      version: "2026.7.2-beta.7",
    });
    writeJson(path.join(packageDir, "openclaw.plugin.json"), {
      id: "bundleddemo",
      name: "bundleddemo",
      configSchema: { type: "object" },
    });
    await seedInstalledPluginIndex(
      {
        bundleddemo: {
          source: "npm",
          spec: "@openclaw/bundleddemo@beta",
          installPath: packageDir,
          version: "2026.7.2-beta.7",
          resolvedName: "@openclaw/bundleddemo",
          resolvedSpec: "@openclaw/bundleddemo@2026.7.2-beta.7",
          resolvedVersion: "2026.7.2-beta.7",
        },
      },
      { config: cfg, env },
    );
    const actualDoctorRegistry = await vi.importActual<
      typeof import("../../doctor-plugin-registry.js")
    >("../../doctor-plugin-registry.js");
    mocks.repairBundled.mockImplementation(
      actualDoctorRegistry.maybeRepairStaleManagedNpmBundledPlugins,
    );
    mocks.repairInstalls.mockImplementation(async (params) => {
      const records =
        params.baselineRecords ??
        (await loadInstalledPluginIndexInstallRecords({ env: params.env }));
      expect(records).not.toHaveProperty("bundleddemo");
      if (params.baselineRecords) {
        await seedInstalledPluginIndex(records, { config: cfg, env: params.env });
      }
      return { changes: [], warnings: [], records };
    });

    const first = await runPostCorePluginConvergence({ cfg, env });
    const projectsAfterFirst = fs.readdirSync(path.join(stateDir, "npm", "projects"));
    const second = await runPostCorePluginConvergence({ cfg, env });

    expect(fs.existsSync(packageDir)).toBe(false);
    expect(projectsAfterFirst).toHaveLength(1);
    expect(fs.readdirSync(path.join(stateDir, "npm", "projects"))).toEqual(projectsAfterFirst);
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env })).not.toHaveProperty(
      "bundleddemo",
    );
    expect(first.installRecords).not.toHaveProperty("bundleddemo");
    expect(second.installRecords).not.toHaveProperty("bundleddemo");
    expect(first.changes).toContain(
      'Removed stale managed install record for bundled plugin "bundleddemo".',
    );
    expect(second.changes).toEqual([]);
  });
});
