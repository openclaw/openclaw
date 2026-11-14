import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const runInstallPolicyMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
  scanInstalledPackageDependencyTreeRuntime,
  scanPackageInstallSourceRuntime,
} = await import("./install-security-scan.runtime.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempDir(prefix = "openclaw-install-scan-") {
  return tempDirs.make(prefix);
}

function scanPackage(
  overrides: Partial<Parameters<typeof scanPackageInstallSourceRuntime>[0]> = {},
) {
  return scanPackageInstallSourceRuntime({
    packageDir: overrides.packageDir ?? makeTempDir(),
    extensions: ["payload.js"],
    logger: {},
    pluginId: "payload",
    ...overrides,
  });
}

const approvalGuidance = [
  "This invocation cannot approve install policy warnings.",
  "To continue:",
  "  • Run the matching direct `openclaw plugins ...` or `openclaw skills ...` command interactively.",
  "  • For reviewed direct CLI automation, add --acknowledge-install-policy-warning.",
  "  • If no equivalent direct command exists, change security.installPolicy to allow this reviewed request, then retry.",
  "  • --force does not approve install policy warnings.",
];

function policyWarning(reason = "review this plugin", fingerprint = "warning-a") {
  return { warning: { reason, fingerprint } };
}
const approvedWarning = () => vi.fn().mockResolvedValue({ status: "approved" });
const officialSource = {
  kind: "npm",
  authority: "official",
  mutable: false,
  network: true,
} as const;
const approvalDetails = {
  reason: "review this plugin",
  requestMode: "install",
  targetName: "payload",
  targetType: "plugin",
};
function expectPolicyRuns(count: number, acknowledgement?: ReturnType<typeof approvedWarning>) {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(count);
  if (acknowledgement) {
    expect(acknowledgement).toHaveBeenCalledTimes(1);
  }
}

function warningWithFinding(prefix: string, severity: "warn" | "critical", fingerprint: string) {
  return {
    ...policyWarning("same bounded reason", fingerprint),
    findings: [
      {
        ruleId: `${prefix}-rule`,
        severity,
        message: "same bounded message",
        evidence: `${prefix} evidence`,
      },
    ],
  };
}

function warningLogger() {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (message: string) => warnings.push(message) } };
}

function scanBundle(sourceDir = makeTempDir()) {
  return scanBundleInstallSourceRuntime({
    logger: {},
    pluginId: "@openclaw/matrix",
    sourceDir,
    source: { kind: "clawhub", authority: "official", mutable: false, network: true },
  });
}

function scanSkill(bundled: boolean) {
  const skillName = bundled ? "peekaboo" : "local-skill";
  return evaluateSkillInstallPolicyRuntime({
    installId: "node",
    logger: {},
    skillName,
    origin: { type: bundled ? "openclaw-bundled" : "workspace", skillName, installId: "node" },
    source: bundled
      ? { kind: "bundled", authority: "openclaw", mutable: false, network: false }
      : { kind: "workspace", authority: "user", mutable: true, network: false },
    sourceDir: bundled ? "/tmp/openclaw-bundled-skill/peekaboo" : "/tmp/local-skill",
  });
}

async function installedPackageFixture(dependencies?: Record<string, string>) {
  const npmRoot = makeTempDir();
  const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "runtime-plugin", ...(dependencies ? { dependencies } : {}) }),
    "utf8",
  );
  return { dependencyScanRootDir: npmRoot, logger: {}, packageDir, pluginId: "runtime-plugin" };
}

async function hostLinkFixture() {
  const request = {
    ...(await installedPackageFixture({ openclaw: "2026.7.1" })),
    allowManagedNpmRootPackagePeerSymlinks: true,
  };
  const hostLink = path.join(request.packageDir, "node_modules", "openclaw");
  await fs.mkdir(path.dirname(hostLink), { recursive: true });
  return { hostLink, request };
}

async function addEscapingDependencyLink(rootDir: string) {
  const outsideRoot = makeTempDir("openclaw-install-outside-");
  const dependencyLink = path.join(rootDir, "node_modules", "outside-package");
  await fs.mkdir(path.dirname(dependencyLink), { recursive: true });
  await fs.symlink(outsideRoot, dependencyLink, "junction");
}

function expectedInstallPolicyNotice(params: {
  findings?: string[];
  guidance?: string[];
  reason?: string;
}): string {
  const lines = [
    "Install requires approval",
    "",
    "  Plugin: payload",
    `  Reason: ${params.reason ?? "review this plugin"}`,
  ];
  if (params.findings?.length) {
    lines.push("  Findings:", ...params.findings.map((finding) => `    • ${finding}`));
  }
  if (params.guidance?.length) {
    lines.push("", ...params.guidance);
  }
  return lines.join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  runInstallPolicyMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("install security scan official bypass", () => {
  const scanOfficialNpm = () =>
    preflightPluginNpmInstallPolicyRuntime({
      logger: {},
      packageName: "@openclaw/matrix",
      requestedSpecifier: "@openclaw/matrix@latest",
      source: officialSource,
      sourcePath: "/tmp/openclaw-official-npm",
    });
  it.each([
    ["bundled skill", () => scanSkill(true), false, true],
    ["immutable official npm", scanOfficialNpm, false, true],
    ["official bundle", () => scanBundle(), true, true],
    ["mutable workspace skill", () => scanSkill(false), true, false],
  ] as const)("applies operator policy to %s", async (_name, scan, blocked, operatorOnly) => {
    const denial = {
      blocked: { code: "security_scan_blocked", reason: "blocked by operator policy" },
    };
    if (blocked) {
      runInstallPolicyMock.mockResolvedValueOnce(denial);
    }
    expect(await scan()).toEqual(blocked ? denial : undefined);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
    if (operatorOnly) {
      expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
    }
  });

  it.each(["bundle", "package", "installed dependencies"] as const)(
    "rejects escaping dependency symlinks for trusted official %s",
    async (kind) => {
      const installed =
        kind === "installed dependencies" ? await installedPackageFixture() : undefined;
      const packageDir = installed?.packageDir ?? makeTempDir();
      await addEscapingDependencyLink(packageDir);
      const scanning = installed
        ? scanInstalledPackageDependencyTreeRuntime({
            ...installed,
            source: officialSource,
            trustedSourceLinkedOfficialInstall: true,
          })
        : kind === "bundle"
          ? scanBundle(packageDir)
          : scanPackage({
              packageDir,
              extensions: ["index.js"],
              pluginId: "@openclaw/matrix",
              source: officialSource,
              trustedSourceLinkedOfficialInstall: true,
            });
      await expect(scanning).rejects.toThrow("node_modules symlink target outside install root");
      expect(runInstallPolicyMock).not.toHaveBeenCalled();
    },
  );
});

describe("installed dependency tree scan", () => {
  it("accepts a managed host link declared as a runtime dependency", async () => {
    const { hostLink, request } = await hostLinkFixture();
    await fs.symlink(process.cwd(), hostLink, "junction");

    await expect(scanInstalledPackageDependencyTreeRuntime(request)).resolves.toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an openclaw dependency symlink that does not target the trusted host", async () => {
    const { hostLink, request } = await hostLinkFixture();
    const outsideRoot = makeTempDir("openclaw-install-outside-");
    await fs.writeFile(path.join(outsideRoot, "package.json"), '{"name":"openclaw"}', "utf8");
    await fs.symlink(outsideRoot, hostLink, "junction");

    await expect(scanInstalledPackageDependencyTreeRuntime(request)).rejects.toThrow(
      "installed dependency scan found package outside install root",
    );
  });
});

describe("package dependency boundaries", () => {
  it.each([
    ["OPENCLAW_INSTALL_SCAN_MAX_DEPTH", "1", "one/two", "exceeded max depth (1)"],
    ["OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES", "2", "two", "exceeded max directories (2)"],
  ])(
    "preserves the admission boundary for %s",
    async (variable, value, overflowDirectory, diagnostic) => {
      const packageDir = makeTempDir();
      await fs.mkdir(path.join(packageDir, "one"));
      await fs.writeFile(path.join(packageDir, "one", "index.js"), "export {};");
      const request = { extensions: ["one/index.js"], logger: {}, packageDir, pluginId: "limits" };
      vi.stubEnv(variable, value);
      await expect(scanPackage(request)).resolves.toBeUndefined();
      expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
      runInstallPolicyMock.mockClear();
      await fs.mkdir(path.join(packageDir, overflowDirectory), { recursive: true });
      await expect(scanPackage(request)).rejects.toThrow(diagnostic);
      expect(runInstallPolicyMock).not.toHaveBeenCalled();
    },
  );

  it("accepts in-tree dependency links and hardlinked files without counting links as directories", async () => {
    const packageDir = makeTempDir();
    const dependency = path.join(packageDir, "node_modules", "dependency");
    await fs.mkdir(dependency, { recursive: true });
    const source = path.join(dependency, "index.js");
    await fs.writeFile(source, "export {};");
    await fs.link(source, path.join(dependency, "linked.js"));
    await fs.symlink(dependency, path.join(packageDir, "node_modules", "alias"), "junction");
    vi.stubEnv("OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES", "3");
    await expect(
      scanPackage({ extensions: ["index.js"], packageDir, pluginId: "in-tree-links" }),
    ).resolves.toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("fails before install policy when a dependency directory cannot be read", async () => {
    const packageDir = makeTempDir();
    const unreadable = path.join(packageDir, "dependency");
    await fs.mkdir(unreadable);
    const readDirectory = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (String(args[0]) === unreadable) {
        throw Object.assign(new Error("directory unavailable"), { code: "EACCES" });
      }
      return readDirectory(...args);
    });
    await expect(
      scanPackage({ extensions: ["index.js"], packageDir, pluginId: "unreadable-dependency" }),
    ).rejects.toThrow(`dependency boundary scan could not read ${unreadable}`);
    expect(runInstallPolicyMock).not.toHaveBeenCalled();
  });
});

describe("plugin install policy warnings", () => {
  it("renders metadata changes that require approval again", async () => {
    const onInstallPolicyWarning = approvedWarning();
    runInstallPolicyMock
      .mockResolvedValueOnce(warningWithFinding("initial", "warn", "full-warning-a"))
      .mockResolvedValueOnce(warningWithFinding("refreshed", "critical", "full-warning-b"));

    const result = await scanPackage({ onInstallPolicyWarning });

    expect(result?.blocked?.reason).toContain("The policy warning changed after approval.");
    expect(result?.blocked?.reason).toContain("same bounded reason");
    expect(result?.blocked?.reason).toContain(
      "[CRITICAL] refreshed-rule: same bounded message Evidence: refreshed evidence",
    );
    expect(result?.blocked?.reason).not.toContain("initial-rule");
    expect(result?.blocked?.reason).not.toContain("initial evidence");
    expectPolicyRuns(2, onInstallPolicyWarning);
  });

  it("blocks policy warnings without acknowledgement", async () => {
    runInstallPolicyMock.mockResolvedValue(policyWarning());

    const result = await scanPackage();

    expect(result?.blocked).toEqual({
      code: "security_scan_blocked",
      installPolicyWarning: approvalDetails,
      reason: expectedInstallPolicyNotice({ guidance: approvalGuidance }),
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["security_scan_blocked", true, "now blocked"],
    ["security_scan_failed", false, "blocked by operator policy"],
  ] as const)("keeps %s terminal (re-evaluated=%s)", async (code, reevaluate, reason) => {
    const onInstallPolicyWarning = approvedWarning();
    if (reevaluate) {
      runInstallPolicyMock.mockResolvedValueOnce(policyWarning());
    }
    runInstallPolicyMock.mockResolvedValueOnce({ blocked: { code, reason } });
    expect((await scanPackage({ onInstallPolicyWarning }))?.blocked).toEqual({ code, reason });
    expect(onInstallPolicyWarning).toHaveBeenCalledTimes(reevaluate ? 1 : 0);
    expectPolicyRuns(reevaluate ? 2 : 1);
  });

  it("renders warning details as one readable review notice", async () => {
    const { warnings, logger } = warningLogger();
    runInstallPolicyMock.mockResolvedValue({
      ...policyWarning(),
      findings: [{ ruleId: "context", severity: "info", message: "Informational context." }],
    });

    await scanPackage({
      logger,
      onInstallPolicyWarning: vi.fn().mockResolvedValue({ status: "declined" }),
    });

    expect(warnings).toEqual([
      `${expectedInstallPolicyNotice({
        findings: ["[INFO] context: Informational context."],
      })}\n`,
    ]);
  });

  function createMaximumPolicyFindings() {
    const maxText = "x".repeat(1_000);
    return {
      maxText,
      findings: Array.from({ length: 100 }, (_, index) => ({
        ruleId: `${String(index).padStart(3, "0")}${"r".repeat(997)}`,
        severity: "critical" as const,
        message: maxText,
        file: maxText,
        evidence: maxText,
      })),
    };
  }

  it("fails closed when a changed warning exceeds the aggregate display limit", async () => {
    const { findings, maxText } = createMaximumPolicyFindings();
    runInstallPolicyMock
      .mockResolvedValueOnce(policyWarning("review this plugin", "initial-warning"))
      .mockResolvedValueOnce({
        ...policyWarning(maxText, "oversized-warning"),
        findings,
      });
    const onInstallPolicyWarning = approvedWarning();
    const { warnings, logger } = warningLogger();

    const result = await scanPackage({ logger, onInstallPolicyWarning });

    expect(result?.blocked).toEqual({
      code: "security_scan_failed",
      reason:
        "install policy failed closed: policy review exceeds the 4,000-character display limit; reduce or coalesce the reason and findings",
    });
    expectPolicyRuns(2, onInstallPolicyWarning);
    expect(warnings.join("\n")).toContain("review this plugin");
    expect(warnings.join("\n")).not.toContain(maxText);
  });

  it.each([
    { size: 4_000, code: "security_scan_blocked" },
    { size: 4_001, code: "security_scan_failed" },
  ] as const)(
    "enforces the aggregate warning boundary at $size characters",
    async ({ size, code }) => {
      const reason = "r".repeat(1_000);
      const ruleId = "u".repeat(700);
      const message = "m".repeat(700);
      const file = "f".repeat(700);
      const findingPrefix = `[CRITICAL] ${ruleId}: ${message} (${file}) Evidence: `;
      const withoutEvidence = expectedInstallPolicyNotice({
        findings: [findingPrefix],
        guidance: approvalGuidance,
        reason,
      });
      const evidence = `${"e".repeat(size - withoutEvidence.length - 3)}\ne`;
      runInstallPolicyMock.mockResolvedValueOnce({
        ...policyWarning(reason, `warning-${String(size)}`),
        findings: [{ ruleId, severity: "critical", message, file, evidence }],
      });

      const result = await scanPackage();

      expect(result?.blocked?.code).toBe(code);
      if (size === 4_000) {
        expect(result?.blocked?.reason).toHaveLength(4_000);
      }
    },
  );

  it("keeps a maximum-size block terminal with a bounded denial", async () => {
    const { findings, maxText } = createMaximumPolicyFindings();
    runInstallPolicyMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: `blocked by install policy: ${maxText}`,
      },
      findings,
    });
    const onInstallPolicyWarning = approvedWarning();

    const result = await scanPackage({ onInstallPolicyWarning });

    expect(result?.blocked?.code).toBe("security_scan_blocked");
    expect(result?.blocked?.reason).toContain("Findings omitted");
    expect(result?.blocked?.reason.length).toBeLessThanOrEqual(4_000);
    expect(onInstallPolicyWarning).not.toHaveBeenCalled();
  });

  it("bounds maximum-size allow findings without blocking the install", async () => {
    const { findings } = createMaximumPolicyFindings();
    runInstallPolicyMock.mockResolvedValue({ findings });
    const { warnings, logger } = warningLogger();

    const result = await scanPackage({ logger });

    expect(result).toBeUndefined();
    expect(warnings.join("\n")).toContain("additional findings omitted");
    expect(warnings.join("\n").length).toBeLessThanOrEqual(4_000);
  });
});

describe("installed plugin runtime compatibility", () => {
  it("warns for resolved transitive runtime dependencies without blocking trusted installs", async () => {
    const root = makeTempDir("openclaw-install-runtime-compatibility-");
    const writePackage = async (
      name: string,
      source: string,
      manifest: Record<string, unknown> = {},
    ) => {
      const dir = name === "runtime-plugin" ? root : path.join(root, "node_modules", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name, version: "1.0.0", ...manifest }),
      );
      if (source) {
        await fs.writeFile(path.join(dir, "index.cjs"), source);
      }
    };
    await writePackage(
      "runtime-plugin",
      "throw new Error('must not execute');\nconsole.log = () => {};",
      {
        dependencies: { direct: "1.0.0" },
        devDependencies: { "dev-only": "1.0.0" },
      },
    );
    await writePackage("direct", "", {
      dependencies: { hoisted: "2.0.0" },
      optionalDependencies: { optional: "3.0.0" },
    });
    await writePackage("hoisted", "Buffer.concat = () => null;", { version: "2.0.0" });
    await writePackage("optional", "process.chdir = () => {};", { version: "3.0.0" });
    await writePackage("dev-only", "new Function('return 1');");
    const warn = vi.fn();
    const result = await scanInstalledPackageDependencyTreeRuntime({
      packageDir: root,
      pluginId: "runtime-plugin",
      logger: { warn },
      source: officialSource,
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("runtime-plugin@1.0.0 index.cjs:2:1"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hoisted@2.0.0 index.cjs:1:1"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("optional@3.0.0 index.cjs:1:1"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("dev-only");
    expectPolicyRuns(1);
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
  });
});
