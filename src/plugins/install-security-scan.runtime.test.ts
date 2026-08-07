import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runInstallPolicyMock = vi.fn();
const findBlockedManifestDependenciesMock = vi.fn();
const findBlockedNodeModulesDirectoryMock = vi.fn();
const findBlockedNodeModulesFileAliasMock = vi.fn();
const findBlockedPackageDirectoryInPathMock = vi.fn();
const findBlockedPackageFileAliasInPathMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("./dependency-denylist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependency-denylist.js")>();
  return {
    ...actual,
    findBlockedManifestDependencies: (...args: unknown[]) =>
      findBlockedManifestDependenciesMock(...args),
    findBlockedNodeModulesDirectory: (...args: unknown[]) =>
      findBlockedNodeModulesDirectoryMock(...args),
    findBlockedNodeModulesFileAlias: (...args: unknown[]) =>
      findBlockedNodeModulesFileAliasMock(...args),
    findBlockedPackageDirectoryInPath: (...args: unknown[]) =>
      findBlockedPackageDirectoryInPathMock(...args),
    findBlockedPackageFileAliasInPath: (...args: unknown[]) =>
      findBlockedPackageFileAliasInPathMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
  scanFileInstallSourceRuntime,
  scanInstalledPackageDependencyTreeRuntime,
} = await import("./install-security-scan.runtime.js");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

function expectOnlyOperatorPolicyRan() {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  expect(findBlockedManifestDependenciesMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesDirectoryMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesFileAliasMock).not.toHaveBeenCalled();
  expect(findBlockedPackageDirectoryInPathMock).not.toHaveBeenCalled();
  expect(findBlockedPackageFileAliasInPathMock).not.toHaveBeenCalled();
  expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
}

function expectedInstallPolicyNotice(params: {
  decision: "warn" | "block";
  findings?: string[];
  guidance?: string[];
  reason: string;
  targetName: string;
  targetType: "skill" | "plugin";
}): string {
  const lines = [
    params.decision === "warn" ? "Install requires approval" : "Install blocked by policy",
    "",
    `  ${params.targetType === "skill" ? "Skill" : "Plugin"}: ${params.targetName}`,
    `  Reason: ${params.reason}`,
  ];
  if (params.findings?.length) {
    lines.push("  Findings:", ...params.findings.map((finding) => `    • ${finding}`));
  }
  if (params.guidance?.length) {
    lines.push("", ...params.guidance);
  }
  return lines.join("\n");
}

beforeEach(() => {
  runInstallPolicyMock.mockReset();
  findBlockedManifestDependenciesMock.mockReset();
  findBlockedNodeModulesDirectoryMock.mockReset();
  findBlockedNodeModulesFileAliasMock.mockReset();
  findBlockedPackageDirectoryInPathMock.mockReset();
  findBlockedPackageFileAliasInPathMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("install security scan official bypass", () => {
  it("bypasses plugin install friction for bundled OpenClaw sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "openclaw/kitchen-sink",
      sourceDir: "/tmp/openclaw-bundled-plugin",
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses plugin install friction for official ClawHub sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses skill install friction for bundled OpenClaw sources", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "openclaw-bundled",
        skillName: "peekaboo",
        installId: "node",
      },
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
      skillName: "peekaboo",
      sourceDir: "/tmp/openclaw-bundled-skill/peekaboo",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("runs only operator policy for official immutable npm sources", async () => {
    const result = await preflightPluginNpmInstallPolicyRuntime({
      logger: {},
      packageName: "@openclaw/matrix",
      requestedSpecifier: "@openclaw/matrix@latest",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourcePath: "/tmp/openclaw-official-npm",
      sourcePathKind: "directory",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("lets operator policy block official sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expectOnlyOperatorPolicyRan();
  });

  it("still runs install policy for mutable workspace skill sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "workspace",
        skillName: "local-skill",
        installId: "node",
      },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "local-skill",
      sourceDir: "/tmp/local-skill",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });
});

describe("installed dependency tree scan", () => {
  it("accepts a managed host link declared as a runtime dependency", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-scan-"));
    tempDirs.push(npmRoot);
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.symlink(process.cwd(), hostLink, "junction");

    const result = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      packageDir,
      pluginId: "runtime-plugin",
    });

    expect(result).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an openclaw dependency symlink that does not target the trusted host", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-scan-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-outside-"));
    tempDirs.push(npmRoot, outsideRoot);
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(outsideRoot, "package.json"), '{"name":"openclaw"}', "utf8");
    await fs.symlink(outsideRoot, hostLink, "junction");

    await expect(
      scanInstalledPackageDependencyTreeRuntime({
        allowManagedNpmRootPackagePeerSymlinks: true,
        dependencyScanRootDir: npmRoot,
        logger: {},
        packageDir,
        pluginId: "runtime-plugin",
      }),
    ).rejects.toThrow("installed dependency scan found package outside install root");
  });
});

describe("legacy file install scan compatibility", () => {
  it("continues after interactive acknowledgement and policy re-evaluation", async () => {
    const onInstallPolicyWarning = vi.fn().mockResolvedValue(true);
    runInstallPolicyMock
      .mockResolvedValueOnce({ warning: { reason: "review this plugin" } })
      .mockResolvedValueOnce({ warning: { reason: "review this plugin" } });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result).toBeUndefined();
    expect(onInstallPolicyWarning).toHaveBeenCalledWith({
      targetName: "payload",
      targetType: "plugin",
      requestMode: "install",
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a block from policy re-evaluation terminal", async () => {
    runInstallPolicyMock
      .mockResolvedValueOnce({ warning: { reason: "review this plugin" } })
      .mockResolvedValueOnce({
        blocked: { code: "security_scan_blocked", reason: "now blocked" },
      });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning: vi.fn().mockResolvedValue(true),
      pluginId: "payload",
    });

    expect(result?.blocked).toEqual({ code: "security_scan_blocked", reason: "now blocked" });
  });

  it("requires acknowledgement for warn and re-evaluates on the acknowledged attempt", async () => {
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: "review this plugin" },
    });

    const firstAttempt = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });
    const acknowledgedAttempt = await scanFileInstallSourceRuntime({
      dangerouslyForceUnsafeInstall: true,
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(firstAttempt?.blocked).toEqual({
      code: "security_scan_blocked",
      reason: expectedInstallPolicyNotice({
        decision: "warn",
        guidance: [
          "To continue:",
          "  • Rerun interactively and approve the warning.",
          "  • For reviewed automation, add --dangerously-force-unsafe-install.",
        ],
        reason: "review this plugin",
        targetName: "payload",
        targetType: "plugin",
      }),
    });
    expect(acknowledgedAttempt).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("renders warning details as one readable review notice", async () => {
    const warnings: string[] = [];
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: "review this plugin" },
      findings: [{ ruleId: "context", severity: "info", message: "Informational context." }],
    });

    await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      onInstallPolicyWarning: vi.fn().mockResolvedValue(false),
      pluginId: "payload",
    });

    expect(warnings).toEqual([
      `${expectedInstallPolicyNotice({
        decision: "warn",
        findings: ["Informational context."],
        reason: "review this plugin",
        targetName: "payload",
        targetType: "plugin",
      })}\n`,
    ]);
  });

  it("renders install policy blocks as one readable denial", async () => {
    runInstallPolicyMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by install policy: unapproved source",
      },
      findings: [{ ruleId: "blocked", severity: "critical", message: "Unsafe package." }],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result?.blocked?.reason).toBe(
      expectedInstallPolicyNotice({
        decision: "block",
        findings: ["Unsafe package."],
        reason: "unapproved source",
        targetName: "payload",
        targetType: "plugin",
      }),
    );
  });

  it.each(["security_scan_blocked", "security_scan_failed"] as const)(
    "does not let acknowledgement override %s",
    async (code) => {
      runInstallPolicyMock.mockResolvedValueOnce({
        blocked: { code, reason: "blocked by operator policy" },
      });

      const result = await scanFileInstallSourceRuntime({
        dangerouslyForceUnsafeInstall: true,
        filePath: "/tmp/payload.js",
        logger: {},
        pluginId: "payload",
      });

      expect(result?.blocked?.reason).toBe("blocked by operator policy");
    },
  );

  it("preserves policy and hook metadata for published lazy install chunks", async () => {
    const warnings: string[] = [];
    const hasHooks = vi.fn().mockReturnValue(true);
    const runBeforeInstall = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ hasHooks, runBeforeInstall });
    runInstallPolicyMock.mockResolvedValueOnce({
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      mode: "update",
      pluginId: "payload",
      requestedSpecifier: "./payload.js",
    });

    expect(result).toBeUndefined();
    expect(warnings).toEqual(["Install policy: Registry requires review."]);
    expect(runInstallPolicyMock).toHaveBeenCalledWith({
      config: undefined,
      logger: expect.any(Object),
      request: {
        targetName: "payload",
        targetType: "plugin",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        source: { kind: "file", authority: "user", mutable: true, network: false },
        origin: { type: "plugin-file" },
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
    });
    expect(hasHooks).toHaveBeenCalledWith("before_install");
    expect(runBeforeInstall).toHaveBeenCalledWith(
      {
        targetName: "payload",
        targetType: "plugin",
        origin: "plugin-file",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        builtinScan: {
          status: "ok",
          scannedFiles: 0,
          critical: 0,
          warn: 0,
          info: 0,
          findings: [],
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
      {
        origin: "plugin-file",
        targetType: "plugin",
        requestKind: "plugin-file",
      },
    );
  });

  it("returns operator policy blocks before invoking hooks", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
  });
});
