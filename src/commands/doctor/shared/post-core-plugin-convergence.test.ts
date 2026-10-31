import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  managedRoots: vi.fn(),
  repairBundled: vi.fn(),
  repairInstalls:
    vi.fn<
      typeof import("./missing-configured-plugin-install.js").repairMissingConfiguredPluginInstalls
    >(),
  repairHostLinks:
    vi.fn<typeof import("../../../plugins/plugin-peer-link.js").repairInstalledOpenClawHostLinks>(),
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
    repairInstalledOpenClawHostLinks: mocks.repairHostLinks,
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

const peerResult = { managedRepaired: 0, registeredRepaired: 0 };

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

function reportPackageReadFailure(
  packageDir: string,
  error = new Error("EACCES: permission denied"),
) {
  mocks.repairHostLinks.mockImplementation(async ({ onPackageReadError }) => {
    onPackageReadError?.(error, packageDir, "managed npm");
    return peerResult;
  });
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
    mocks.repairHostLinks.mockResolvedValue(peerResult);
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
    "preserves the %s repair failure policy",
    async (kind) => {
      const refusal = new Error("one-shot peer repair refusal");
      const laterWrite = vi.fn();
      let refuse = false;
      mocks.repairHostLinks.mockImplementation(async ({ beforePersistentApply }) => {
        if (kind === "filesystem") {
          throw refusal;
        }
        refuse = true;
        try {
          beforePersistentApply?.();
        } catch {}
        // A sibling must still be fenced after the raw one-shot guard resets.
        beforePersistentApply?.();
        laterWrite();
        return peerResult;
      });
      const operation = runPostCorePluginConvergence({
        cfg: { plugins: { enabled: false } },
        env: {},
        beforePersistentEffect: () => {
          if (refuse) {
            refuse = false;
            throw refusal;
          }
        },
      });
      if (kind === "authority") {
        await expect(operation).rejects.toBe(refusal);
        expect(laterWrite).not.toHaveBeenCalled();
        expect(mocks.smokeCheck).not.toHaveBeenCalled();
      } else {
        await expect(operation).resolves.toHaveProperty("warnings", [
          expect.objectContaining({ message: expect.stringContaining(refusal.message) }),
        ]);
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
      await converge(configured(), {
        compatibilityHostVersion,
        env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.12" },
      });
      expect(mocks.repairInstalls.mock.calls[0]?.[0].env).toMatchObject({
        OPENCLAW_COMPATIBILITY_HOST_VERSION: expected,
      });
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
        openclaw: { extensions: ["./dist/index.js"] },
      });
      packages.push(packageDir);
    }
    const active = expectDefined(packages[0], "active package");
    const registered = path.join(stateDir, "extensions", "email");
    writeJson(path.join(registered, "package.json"), {
      name: "@fixture/email",
      dependencies: { openclaw: "*" },
      openclaw: { extensions: ["./index.js"] },
    });
    fs.writeFileSync(path.join(registered, "index.js"), "export default {};\n");
    writeJson(path.join(registered, "node_modules", "openclaw", "package.json"), {
      name: "openclaw",
      version: "2026.7.1-beta.2",
    });
    mockRepairs(
      {
        selected: { source: "npm", installPath: active },
        email: { source: "npm", installPath: registered },
      },
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
    mocks.repairHostLinks.mockImplementation(peers.repairInstalledOpenClawHostLinks);
    const payload = await vi.importActual<
      typeof import("../../../plugins/payload-verification.js")
    >("../../../plugins/payload-verification.js");
    mocks.smokeCheck.mockImplementation(async (params) => {
      for (const packageDir of [active, registered]) {
        expect(fs.realpathSync(path.join(packageDir, "node_modules", "openclaw"))).toBe(
          fs.realpathSync(process.cwd()),
        );
      }
      return await payload.runPluginPayloadSmokeCheck(params);
    });
    const reads = vi.spyOn(fs.promises, "readdir");
    try {
      const result = await converge(configured("selected", "email"), {
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      expect(result).toMatchObject({
        errored: false,
        changes: [
          'Repaired missing configured plugin "selected".',
          "Repaired OpenClaw host peer link(s) for 1 managed npm plugin package(s).",
          "Repaired OpenClaw host peer link(s) for 1 registered plugin package(s).",
        ],
        repairedPluginIds: ["selected"],
        warnings: [],
        smokeFailures: [],
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

    expect(mocks.repairInstalls.mock.calls[0]?.[0].baselineRecords).toEqual({
      brave: baseline.brave,
    });
    expect(result).toMatchObject({
      changes: ['Removed stale local bundled plugin install record "discord".'],
    });
    expect(result.installRecords).toEqual({ brave: baseline.brave });
  });

  it.each([false, true])("attributes repair diagnostics; consent blocks=%s", async (blocked) => {
    const message = blocked ? "Capability consent required" : "Install failed: ENETUNREACH";
    const unclassified = "Failed to read inventory";
    const notice = "Security scan pending";
    mocks.repairInstalls.mockImplementation(async ({ onWarning }) => {
      onWarning?.({ message, pluginId: "discord" });
      onWarning?.({ message: unclassified });
      return repairResult(
        {},
        {
          warnings: [message, unclassified],
          notices: [notice],
          ...(blocked
            ? {
                failedPluginIds: ["discord"],
                outcomes: [
                  {
                    pluginId: "discord",
                    status: "error" as const,
                    code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
                    message,
                  },
                ],
              }
            : {}),
        },
      );
    });
    const result = await converge(configured("discord"));
    expect(result).toMatchObject({ errored: blocked, smokeFailures: [], installRecords: {} });
    expect(result.warnings).toStrictEqual([
      repairWarning(message, { kind: "repair", pluginId: "discord" }),
      repairWarning(unclassified),
    ]);
    expect(result.notices).toStrictEqual([{ reason: notice, message: notice, guidance: [] }]);
  });

  it.each(["missing-install-path", "unreadable-package-json"] as const)(
    "keeps __proto__ records and classifies %s smoke failures",
    async (reason) => {
      const stateDir = makeTempDir();
      const installPath = path.join(stateDir, "npm", "node_modules", "__proto__");
      const unreadable = reason === "unreadable-package-json";
      const record: PluginInstallRecord = { source: "npm", ...(unreadable ? { installPath } : {}) };
      const records = Object.create(null) as Records;
      Object.assign(records, { ["__proto__"]: record });
      mockRepairs(records);
      if (unreadable) {
        reportPackageReadFailure(installPath);
      }
      mocks.smokeCheck.mockImplementation(async (params: { records: Records }) => {
        expect(Object.getPrototypeOf(params.records)).toBeNull();
        expect(Object.keys(params.records)).toEqual(["__proto__"]);
        expect(Object.getOwnPropertyDescriptor(params.records, "__proto__")?.value).toBe(record);
        return smokeResult({
          pluginId: "__proto__",
          ...(unreadable ? { installPath } : {}),
          reason,
          detail: unreadable
            ? `Could not read ${installPath}/package.json: EACCES`
            : "Install path is missing.",
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
        kind: "load",
        reason: expect.stringContaining(reason),
        guidance: [
          unreadable
            ? expect.stringContaining(path.join(installPath, "package.json"))
            : "Run `openclaw update repair` to retry plugin repair.",
          "Run `openclaw plugins inspect __proto__ --runtime --json` for details.",
        ],
      });
      expect(result.errored).toBe(true);
    },
  );

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
