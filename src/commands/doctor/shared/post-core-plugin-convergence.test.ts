import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
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

// mock-isolation: Exercise convergence without installing real plugin packages.
vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairInstalls,
}));
// mock-isolation: Control repair results without mutating installed plugin state.
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
vi.mock("../../../plugins/installed-plugin-npm-roots.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/installed-plugin-npm-roots.js")>();
  return { ...actual, listManagedPluginNpmRootsForInstallRecords: mocks.managedRoots };
});
// mock-isolation: Script payload checks without launching installed plugin code.
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
import type { PluginPayloadSmokeFailure } from "../../../plugins/payload-verification.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../../../plugins/test-helpers/managed-npm-plugin.js";
import { VERSION } from "../../../version.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

type Records = Record<string, PluginInstallRecord>;

function repairResult(
  records: Records = {},
  extra: Partial<Awaited<ReturnType<typeof mocks.repairInstalls>>> = {},
) {
  return { changes: [], warnings: [], records, ...extra };
}

function mockRepairs(...args: Parameters<typeof repairResult>) {
  mocks.repairInstalls.mockResolvedValue(repairResult(...args));
}

function repairWarning(message: string, owner: { kind?: "repair"; pluginId?: string } = {}) {
  return {
    ...owner,
    reason: message,
    message,
    guidance: ["Run `openclaw update repair` to retry plugin repair."],
  };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const peerResult = { checked: 0, attempted: 0, repaired: 0, skipped: 0 };

function configured(...ids: string[]): OpenClawConfig {
  return { plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) } };
}

function converge(
  cfg: OpenClawConfig,
  params: Partial<Omit<Parameters<typeof runPostCorePluginConvergence>[0], "cfg">> = {},
) {
  return runPostCorePluginConvergence({ cfg, env: {}, ...params });
}

function bundledEnv(bundledRoot: string) {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    VITEST: "true",
  };
}

function expectRepairInput(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, baselineRecords?: Records) {
  expect(mocks.repairInstalls).toHaveBeenCalledWith({
    cfg,
    repairVersionDrift: false,
    env: { ...env, OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    ...(baselineRecords ? { baselineRecords } : {}),
    onWarning: expect.any(Function),
    beforePersistentEffect: expect.any(Function),
  });
}

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

function smokeResult(failure: PluginPayloadSmokeFailure) {
  return { checked: [failure.pluginId], failures: [failure] };
}

describe("runPostCorePluginConvergence", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const makeTempDir = () => tempDirs.make("openclaw-post-core-convergence-");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managedRoots.mockImplementation(({ npmRoot }: { npmRoot: string }) => [npmRoot]);
    mocks.repairBundled.mockReturnValue(null);
    mockRepairs();
    mocks.relinkPeers.mockResolvedValue(peerResult);
    mocks.smokeCheck.mockResolvedValue({ checked: [], failures: [] });
  });

  function writeBundledPlugin(pluginDir: string, version = "2026.5.20-beta.1") {
    const pluginId = path.basename(pluginDir);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: pluginId,
      name: pluginId,
      version,
      configSchema: { type: "object" },
    });
    writeJson(path.join(pluginDir, "package.json"), { name: `@openclaw/${pluginId}`, version });
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
      mocks.managedRoots.mockReturnValue(["first-root", "second-root"]);
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
        await nextImmediate();
        expect(completed).toBe(false);
        expect(mocks.smokeCheck).not.toHaveBeenCalled();
      } finally {
        releaseSibling.resolve();
        await operation;
      }
      const result = await operation;
      expect(siblingSettled).toBe(true);
      if (kind === "authority") {
        expect("error" in result ? result.error : undefined).toBe(refusal);
        expect(laterWrite).not.toHaveBeenCalled();
        expect(mocks.smokeCheck).not.toHaveBeenCalled();
      } else {
        expect(result).toHaveProperty("value.warnings", [
          expect.objectContaining({ message: expect.stringContaining(refusal.message) }),
        ]);
        expect(laterWrite).toHaveBeenCalledOnce();
        expect(mocks.smokeCheck).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    [undefined, VERSION],
    ["2026.7.2-beta.7", "2026.7.2-beta.7"],
  ] as const)(
    "uses startup host version %s instead of a stale inherited version",
    async (compatibilityHostVersion, expected) => {
      const cfg = configured();
      await converge(cfg, {
        compatibilityHostVersion,
        env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.12" },
      });
      expectRepairInput(cfg, { OPENCLAW_COMPATIBILITY_HOST_VERSION: expected });
    },
  );

  it("repairs the selected generation before smoke checks without walking stale roots", async () => {
    const stateDir = makeTempDir();
    const packageName = "@fixture/selected";
    const packages: string[] = [];
    for (const generationKey of ["active", "stale-1", "stale-2"]) {
      const flatPackage = writeManagedNpmPlugin({
        stateDir,
        packageName,
        pluginId: "selected",
        version: "1.0.0",
      });
      const root = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey,
      });
      fs.renameSync(path.dirname(path.dirname(path.dirname(flatPackage))), root);
      const packageDir = path.join(root, "node_modules", ...packageName.split("/"));
      writeJson(path.join(packageDir, "package.json"), {
        name: packageName,
        version: "1.0.0",
        peerDependencies: { openclaw: "*" },
      });
      packages.push(packageDir);
    }
    const active = expectDefined(packages[0], "active package");
    mockRepairs(
      { selected: { source: "npm", installPath: active } },
      {
        changes: ['Repaired missing configured plugin "selected".'],
        repairedPluginIds: ["selected"],
      },
    );
    const roots = await vi.importActual<
      typeof import("../../../plugins/installed-plugin-npm-roots.js")
    >("../../../plugins/installed-plugin-npm-roots.js");
    const peers = await vi.importActual<typeof import("../../../plugins/plugin-peer-link.js")>(
      "../../../plugins/plugin-peer-link.js",
    );
    mocks.managedRoots.mockImplementation(roots.listManagedPluginNpmRootsForInstallRecords);
    mocks.relinkPeers.mockImplementation(peers.relinkOpenClawPeerDependenciesInManagedNpmRoot);
    mocks.smokeCheck.mockImplementation(async () => {
      expect(fs.realpathSync(path.join(active, "node_modules", "openclaw"))).toBe(
        fs.realpathSync(process.cwd()),
      );
      return { checked: ["selected"], failures: [] };
    });
    const reads = vi.spyOn(fs.promises, "readdir");
    try {
      const result = await converge(configured("selected"), {
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      expect(result).toMatchObject({
        errored: false,
        changes: [
          'Repaired missing configured plugin "selected".',
          "Repaired OpenClaw host peer link(s) for 1 managed npm plugin package(s).",
        ],
        repairedPluginIds: ["selected"],
        warnings: [],
      });
      expect(mocks.smokeCheck).toHaveBeenCalledOnce();
      for (const stale of packages.slice(1)) {
        expect(fs.existsSync(path.join(stale, "node_modules", "openclaw"))).toBe(false);
        expect(
          reads.mock.calls.some(([dir]) =>
            String(dir).startsWith(path.dirname(path.dirname(stale))),
          ),
        ).toBe(false);
      }
    } finally {
      reads.mockRestore();
    }
  });

  it.each(["peerDependencies", "dependencies"] as const)(
    "repairs a registered extensions-root %s stale host before the real payload smoke check",
    async (dependencyField) => {
      const stateDir = makeTempDir();
      const packageDir = path.join(stateDir, "extensions", "email");
      const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
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
      mockRepairs(records);
      mocks.smokeCheck.mockImplementation(async (params) => {
        const actual = await vi.importActual<
          typeof import("../../../plugins/payload-verification.js")
        >("../../../plugins/payload-verification.js");
        return await actual.runPluginPayloadSmokeCheck(params);
      });

      const result = await converge(configured("email"), {
        env: { OPENCLAW_STATE_DIR: stateDir },
        baselineInstallRecords: records,
      });

      expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
      expect(result).toMatchObject({ errored: false, smokeFailures: [] });
    },
  );

  it("prunes stale local bundled plugin shadows from baseline records before repair", async () => {
    const bundledRoot = makeTempDir();
    writeBundledPlugin(path.join(bundledRoot, "discord"));
    const baseline = {
      discord: {
        source: "path" as const,
        installPath: path.join(makeTempDir(), "dist", "extensions", "discord"),
        version: "2026.5.4-beta.3",
      },
      brave: { source: "npm" as const, installPath: "/p/brave" },
    };
    mockRepairs({ brave: baseline.brave });
    const cfg = configured("discord", "brave");

    const result = await converge(cfg, {
      env: bundledEnv(bundledRoot),
      baselineInstallRecords: baseline,
    });

    expectRepairInput(
      cfg,
      {
        ...bundledEnv(bundledRoot),
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
      },
      { brave: baseline.brave },
    );
    expect(result).toMatchObject({
      changes: ['Removed stale local bundled plugin install record "discord".'],
    });
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
    const result = await converge(configured("discord"));
    expect(result.errored).toBe(false);
    expect(result.warnings).toStrictEqual([
      repairWarning(message, { kind: "repair", pluginId: "discord" }),
      repairWarning(unclassifiedMessage),
    ]);
  });

  it("blocks convergence when a missing plugin cannot activate without capability consent", async () => {
    const message = 'Plugin "consent-fixture" requires capability consent.';
    mocks.repairInstalls.mockImplementation(async ({ onWarning }) => {
      onWarning?.({ message, pluginId: "consent-fixture" });
      return {
        ...repairResult(),
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
      };
    });

    const result = await converge(configured("consent-fixture"));
    expect(result).toMatchObject({
      errored: true,
      warnings: [expect.objectContaining({ message })],
      smokeFailures: [],
    });
    expect(result.installRecords).toEqual({});
  });

  it("surfaces repair notices without marking convergence errored", async () => {
    const notice = 'ClawHub trust warning for "@openclaw/discord@1.2.3": security scan is pending.';
    mockRepairs(
      { discord: { source: "clawhub", installPath: "/p/discord" } },
      { notices: [notice] },
    );
    const result = await converge(configured("discord"));
    expect(result).toMatchObject({ errored: false, warnings: [] });
    expect(result.notices).toStrictEqual([{ reason: notice, message: notice, guidance: [] }]);
  });

  it("flags errored=true when smoke check finds a missing install path", async () => {
    mockRepairs({ brave: { source: "npm" } });
    mocks.smokeCheck.mockResolvedValue(
      smokeResult({
        pluginId: "brave",
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      }),
    );
    const result = await converge(configured("brave"));
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
    const stateDir = makeTempDir();
    const installPath = path.join(
      stateDir,
      "npm",
      "projects",
      "__proto__",
      "node_modules",
      "__proto__",
    );
    const record: PluginInstallRecord = { source: "npm", installPath };
    const records = Object.create(null) as Records;
    Object.assign(records, { ["__proto__"]: record });
    mockRepairs(records);
    reportPackageReadFailure(installPath);
    mocks.smokeCheck.mockImplementation(async (params: { records: Records }) => {
      expect(Object.getPrototypeOf(params.records)).toBeNull();
      expect(Object.keys(params.records)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(params.records, "__proto__")?.value).toBe(record);
      return smokeResult({
        pluginId: "__proto__",
        installPath,
        reason: "unreadable-package-json",
        detail: `Could not read package.json at ${installPath}/package.json: EACCES`,
      });
    });

    const result = await converge(
      { plugins: { enabled: true } },
      {
        env: { OPENCLAW_STATE_DIR: stateDir },
      },
    );

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

  it.each([true, false])(
    "classifies package read errors for inactive tracked=%s installs",
    async (tracked) => {
      const stateDir = makeTempDir();
      const installPath = tracked
        ? path.join(stateDir, "npm", "projects", "brave", "node_modules", "brave")
        : path.join(stateDir, "npm", "node_modules", "untracked");
      mockRepairs(tracked ? { brave: { source: "npm", installPath } } : {});
      const detail = tracked
        ? `EACCES: permission denied, open '${installPath}/package.json'`
        : "EACCES: permission denied";
      reportPackageReadFailure(installPath, new Error(detail));
      const cfg: OpenClawConfig = tracked
        ? { plugins: { entries: { brave: { enabled: false } } } }
        : configured();
      const result = await converge(cfg, {
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      const message =
        "Failed to repair installed OpenClaw host peer links: EACCES: permission denied";
      expect(result.warnings).toStrictEqual(tracked ? [] : [repairWarning(message)]);
      expect(mocks.smokeCheck).toHaveBeenCalledWith({ records: {}, env: expect.any(Object) });
      expect(result.errored).toBe(false);
    },
  );

  it("retires payload and record state before repair across two starts", async () => {
    const stateDir = makeTempDir();
    const bundledRoot = tempDirs.make("openclaw-post-core-bundled-");
    const cfg = {
      update: { channel: "beta" as const },
      plugins: { allow: ["bundleddemo"], entries: { bundleddemo: { enabled: true } } },
    };
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      ...bundledEnv(bundledRoot),
    };
    writeBundledPlugin(path.join(bundledRoot, "bundleddemo"), VERSION);
    const npmRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName: "@openclaw/bundleddemo",
      generationKey: "@openclaw/bundleddemo@2026.7.2-beta.7",
    });
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "bundleddemo");
    writeBundledPlugin(packageDir, "2026.7.2-beta.7");
    writeJson(path.join(npmRoot, "package.json"), {
      dependencies: { "@openclaw/bundleddemo": "2026.7.2-beta.7" },
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
