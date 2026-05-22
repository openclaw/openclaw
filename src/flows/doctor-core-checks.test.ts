import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry } from "../agents/skills-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CORE_HEALTH_CHECKS,
  createCoreHealthChecks,
  type CoreHealthCheckDeps,
  registerCoreHealthChecks,
  resetCoreHealthChecksForTest,
} from "./doctor-core-checks.js";
import { doctorHealthConversionRules } from "./doctor-health-conversion-plan.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "missing-tool",
    description: "Missing tool",
    source: "workspace",
    bundled: false,
    filePath: "/tmp/openclaw-test-workspace/skills/missing-tool/SKILL.md",
    baseDir: "/tmp/openclaw-test-workspace/skills/missing-tool",
    skillKey: "missing-tool",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: false,
    modelVisible: false,
    userInvocable: true,
    commandVisible: false,
    requirements: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createDeps(overrides: Partial<CoreHealthCheckDeps> = {}): CoreHealthCheckDeps {
  return {
    async detectUnavailableSkills(): Promise<readonly SkillStatusEntry[]> {
      return [];
    },
    async collectSecurityWarnings(): Promise<readonly string[]> {
      return [];
    },
    async collectWorkspaceSuggestionNotes(): Promise<readonly string[]> {
      return [];
    },
    ...overrides,
  };
}

function getCheck(checks: readonly HealthCheck[], id: string): HealthCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing health check ${id}`);
  }
  return check;
}

const detectShellCompletionHealth = vi.hoisted(() => vi.fn(async () => []));
const doctorCoreCheckMocks = vi.hoisted(() => ({
  loadBundledPluginPublicSurfaceModuleSync: vi.fn(),
  noteClaudeCliHealth: vi.fn(),
}));
const pluginRegistryMocks = vi.hoisted(() => ({
  detectPluginRegistryStateIssues: vi.fn(async (): Promise<unknown[]> => []),
  repairPluginRegistryState: vi.fn(async (params: { config: OpenClawConfig }) => ({
    config: params.config,
    changes: [],
    warnings: [],
  })),
}));
const sandboxMocks = vi.hoisted(() => ({
  detectSandboxRegistryFileIssues: vi.fn(async (): Promise<unknown[]> => []),
  detectSandboxImageIssues: vi.fn(async (): Promise<unknown[]> => []),
  repairSandboxImages: vi.fn(async (params: { cfg: OpenClawConfig }) => ({
    config: params.cfg,
    changes: [],
    warnings: [],
  })),
  migrateLegacySandboxRegistryFiles: vi.fn(async (): Promise<unknown[]> => []),
  formatLegacySandboxRegistryMigrationLine: vi.fn((result: { kind: string }) => {
    return `- Migrated ${result.kind} registry.`;
  }),
  collectSandboxScopeWarnings: vi.fn((): unknown[] => []),
}));
const gatewayServiceMocks = vi.hoisted(() => ({
  detectExtraGatewayServices: vi.fn<() => Promise<unknown>>(async () => ({
    services: [],
    legacyServices: [],
    cleanupHints: [],
  })),
  formatExtraGatewayServiceFinding: vi.fn((svc: { label: string }) => {
    return `Gateway-like service detected: ${svc.label}.`;
  }),
  detectGatewayServiceConfigIssues: vi.fn<() => Promise<unknown>>(async () => ({
    status: "clean",
    issues: [],
  })),
  repairGatewayServiceConfig: vi.fn(async () => undefined),
  repairExtraGatewayServices: vi.fn(
    async (): Promise<{ removed: string[]; failed: string[] }> => ({ removed: [], failed: [] }),
  ),
  classifyLegacyServices: vi.fn(
    (services: Array<{ label: string; platform: string; scope: string }>) => {
      return {
        darwinUserServices: services.filter(
          (svc) => svc.platform === "darwin" && svc.scope === "user",
        ),
        linuxUserServices: services.filter(
          (svc) => svc.platform === "linux" && svc.scope === "user",
        ),
        failed: services
          .filter(
            (svc) =>
              !((svc.platform === "darwin" || svc.platform === "linux") && svc.scope === "user"),
          )
          .map((svc) => `${svc.label} (${svc.scope})`),
      };
    },
  ),
}));

vi.mock("../commands/doctor-completion.js", () => ({
  detectShellCompletionHealth,
}));

vi.mock("../commands/doctor-claude-cli.js", () => ({
  noteClaudeCliHealth: doctorCoreCheckMocks.noteClaudeCliHealth,
}));

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync:
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../commands/doctor-plugin-registry.js", () => ({
  detectPluginRegistryStateIssues: pluginRegistryMocks.detectPluginRegistryStateIssues,
  repairPluginRegistryState: pluginRegistryMocks.repairPluginRegistryState,
}));

vi.mock("../commands/doctor-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/doctor-sandbox.js")>();
  return {
    ...actual,
    detectSandboxRegistryFileIssues: sandboxMocks.detectSandboxRegistryFileIssues,
    detectSandboxImageIssues: sandboxMocks.detectSandboxImageIssues,
    repairSandboxImages: sandboxMocks.repairSandboxImages,
    formatLegacySandboxRegistryMigrationLine: sandboxMocks.formatLegacySandboxRegistryMigrationLine,
    collectSandboxScopeWarnings: sandboxMocks.collectSandboxScopeWarnings,
  };
});

vi.mock("../agents/sandbox/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/sandbox/registry.js")>();
  return {
    ...actual,
    migrateLegacySandboxRegistryFiles: sandboxMocks.migrateLegacySandboxRegistryFiles,
  };
});

vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServices: gatewayServiceMocks.detectExtraGatewayServices,
  formatExtraGatewayServiceFinding: gatewayServiceMocks.formatExtraGatewayServiceFinding,
  detectGatewayServiceConfigIssues: gatewayServiceMocks.detectGatewayServiceConfigIssues,
  repairGatewayServiceConfig: gatewayServiceMocks.repairGatewayServiceConfig,
  repairExtraGatewayServices: gatewayServiceMocks.repairExtraGatewayServices,
  classifyLegacyServices: gatewayServiceMocks.classifyLegacyServices,
}));

describe("registerCoreHealthChecks", () => {
  let tmp: string | undefined;

  beforeEach(() => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync.mockReset();
    doctorCoreCheckMocks.noteClaudeCliHealth.mockReset();
    pluginRegistryMocks.detectPluginRegistryStateIssues.mockReset();
    pluginRegistryMocks.detectPluginRegistryStateIssues.mockResolvedValue([]);
    pluginRegistryMocks.repairPluginRegistryState.mockReset();
    pluginRegistryMocks.repairPluginRegistryState.mockImplementation(
      async (params: { config: OpenClawConfig }) => ({
        config: params.config,
        changes: [],
        warnings: [],
      }),
    );
    sandboxMocks.detectSandboxRegistryFileIssues.mockReset();
    sandboxMocks.detectSandboxRegistryFileIssues.mockResolvedValue([]);
    sandboxMocks.detectSandboxImageIssues.mockReset();
    sandboxMocks.detectSandboxImageIssues.mockResolvedValue([]);
    sandboxMocks.repairSandboxImages.mockReset();
    sandboxMocks.repairSandboxImages.mockImplementation(
      async (params: { cfg: OpenClawConfig }) => ({
        config: params.cfg,
        changes: [],
        warnings: [],
      }),
    );
    sandboxMocks.migrateLegacySandboxRegistryFiles.mockReset();
    sandboxMocks.migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
    sandboxMocks.collectSandboxScopeWarnings.mockReset();
    sandboxMocks.collectSandboxScopeWarnings.mockReturnValue([]);
    gatewayServiceMocks.detectExtraGatewayServices.mockReset();
    gatewayServiceMocks.detectExtraGatewayServices.mockResolvedValue({
      services: [],
      legacyServices: [],
      cleanupHints: [],
    });
    gatewayServiceMocks.formatExtraGatewayServiceFinding.mockReset();
    gatewayServiceMocks.formatExtraGatewayServiceFinding.mockImplementation(
      (svc: { label: string }) => `Gateway-like service detected: ${svc.label}.`,
    );
    gatewayServiceMocks.detectGatewayServiceConfigIssues.mockReset();
    gatewayServiceMocks.detectGatewayServiceConfigIssues.mockResolvedValue({
      status: "clean",
      issues: [],
    });
    gatewayServiceMocks.repairGatewayServiceConfig.mockReset();
    gatewayServiceMocks.repairGatewayServiceConfig.mockResolvedValue(undefined);
    gatewayServiceMocks.repairExtraGatewayServices.mockReset();
    gatewayServiceMocks.repairExtraGatewayServices.mockResolvedValue({ removed: [], failed: [] });
    gatewayServiceMocks.classifyLegacyServices.mockClear();
  });

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("registers the built-in health checks once", () => {
    registerCoreHealthChecks();
    registerCoreHealthChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual(
      CORE_HEALTH_CHECKS.map((check) => check.id),
    );
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerHealthCheck({
      id: "core/doctor/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    });

    expect(() => registerCoreHealthChecks()).toThrow("health check already registered");

    clearHealthChecksForTest();
    registerCoreHealthChecks();

    expect(listHealthChecks()).toHaveLength(CORE_HEALTH_CHECKS.length);
  });

  it("registers only implemented core health targets from the doctor conversion inventory", () => {
    registerCoreHealthChecks();

    const registeredIds = new Set(listHealthChecks().map((check) => check.id));
    const coreTargets = new Set<string>(
      doctorHealthConversionRules.flatMap((rule) =>
        rule.target.filter((target) => target.startsWith("core/doctor/")),
      ),
    );
    const plannedOnlyTargets = [
      "core/doctor/auth-profiles/keychain",
      "core/doctor/session-locks",
      "core/doctor/gateway-daemon",
    ];

    for (const id of CORE_HEALTH_CHECKS.map((check) => check.id)) {
      if (id === "core/doctor/browser-clawd-profile-residue") {
        continue;
      }
      expect(coreTargets.has(id)).toBe(true);
    }
    for (const id of plannedOnlyTargets) {
      expect(registeredIds.has(id)).toBe(false);
    }
    expect(
      CORE_HEALTH_CHECKS.some((check) =>
        check.description.endsWith("represented in the health registry."),
      ),
    ).toBe(false);
  });

  it("converts unavailable skills into repair-capable health findings", async () => {
    const unavailableSkill = createSkill();
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-test-workspace",
          skills: ["missing-tool"],
        },
      },
    };
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async detectUnavailableSkills(): Promise<readonly SkillStatusEntry[]> {
            return [unavailableSkill];
          },
        }),
      ),
      "core/doctor/skills-readiness",
    );

    expect(check.repair).toBeTypeOf("function");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg,
      cwd: "/tmp/openclaw-test-workspace",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: "/tmp/openclaw-test-workspace",
        },
        { paths: ["skills.entries.other-tool.enabled"] },
      ),
    ).resolves.toEqual([]);
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: "/tmp/openclaw-test-workspace",
        },
        { paths: ["skills.entries.missing-tool.enabled"] },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        path: "skills.entries.missing-tool.enabled",
      }),
    );

    const repaired = await check.repair?.(
      {
        mode: "fix",
        runtime,
        cfg,
        cwd: "/tmp/openclaw-test-workspace",
      },
      findings,
    );
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });

  it("converts security doctor warnings into health findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectSecurityWarnings(): Promise<readonly string[]> {
            return [
              '- CRITICAL: Gateway bound to "lan" (0.0.0.0) without authentication.',
              '- WARNING: Gateway bound to "lan" (0.0.0.0).',
            ];
          },
        }),
      ),
      "core/doctor/security",
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        gateway: {
          bind: "lan",
          auth: {
            mode: "none",
          },
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "error",
        message: expect.stringContaining("Gateway bound"),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "warning",
        message: expect.stringContaining("Gateway bound"),
      }),
    );
  });

  it("converts Claude CLI presentation notes into lint findings without a note sink", async () => {
    doctorCoreCheckMocks.noteClaudeCliHealth.mockImplementation((_cfg, deps) => {
      deps.noteFn("- Claude CLI is not ready.\n- Fix: run claude auth login.", "Claude CLI");
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/claude-cli");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {},
      cwd: "/tmp/openclaw-test-workspace",
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/claude-cli",
        severity: "warning",
        message: "Claude CLI is not ready.",
        fixHint: "- Fix: run claude auth login.",
      }),
    ]);
  });

  it("emits Claude CLI presentation notes through the doctor note sink", async () => {
    doctorCoreCheckMocks.noteClaudeCliHealth.mockImplementation((_cfg, deps) => {
      deps.noteFn("- Claude CLI is not ready.", "Claude CLI");
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/claude-cli");
    const note = vi.fn();

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {},
      cwd: "/tmp/openclaw-test-workspace",
      doctor: { note },
    });

    expect(findings).toEqual([]);
    expect(note).toHaveBeenCalledWith("- Claude CLI is not ready.", "Claude CLI");
  });

  it("keeps healthy Claude CLI presentation notes out of lint findings", async () => {
    doctorCoreCheckMocks.noteClaudeCliHealth.mockImplementation((_cfg, deps) => {
      deps.noteFn(
        [
          "- Binary: /usr/local/bin/claude.",
          "- Headless Claude auth: OK (oauth).",
          "- OpenClaw auth profile: claude-cli (provider claude-cli).",
        ].join("\n"),
        "Claude CLI",
      );
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/claude-cli");

    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: {},
        cwd: "/tmp/openclaw-test-workspace",
      }),
    ).resolves.toEqual([]);
  });

  it("converts browser presentation notes into lint findings without a note sink", async () => {
    const noteChromeMcpBrowserReadiness = vi.fn(async (_cfg, deps) => {
      deps.noteFn("- Browser health check is unavailable: missing facade.", "Browser");
    });
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      noteChromeMcpBrowserReadiness,
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/browser");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {},
      cwd: "/tmp/openclaw-test-workspace",
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/browser",
        severity: "warning",
        message: "Browser health check is unavailable: missing facade.",
      }),
    ]);
  });

  it("emits browser presentation notes through the doctor note sink", async () => {
    const noteChromeMcpBrowserReadiness = vi.fn(async (_cfg, deps) => {
      deps.noteFn("- Browser health check is unavailable: missing facade.", "Browser");
    });
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      noteChromeMcpBrowserReadiness,
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/browser");
    const note = vi.fn();

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {},
      cwd: "/tmp/openclaw-test-workspace",
      doctor: { note },
    });

    expect(findings).toEqual([]);
    expect(note).toHaveBeenCalledWith(
      "- Browser health check is unavailable: missing facade.",
      "Browser",
    );
  });

  it("keeps browser guidance notes out of lint findings", async () => {
    const noteChromeMcpBrowserReadiness = vi.fn(async (_cfg, deps) => {
      deps.noteFn(
        [
          "- Chrome MCP existing-session is configured for profile(s): chromeLive.",
          "- Chrome path: /usr/bin/google-chrome",
          "- Detected Chrome Google Chrome 144.0.7534.0.",
          "- Enable remote debugging in the browser inspect page (chrome://inspect/#devices).",
        ].join("\n"),
        "Browser",
      );
    });
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      noteChromeMcpBrowserReadiness,
    });
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/browser");

    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: {},
        cwd: "/tmp/openclaw-test-workspace",
      }),
    ).resolves.toEqual([]);
  });

  it("emits workspace suggestions as doctor notes, not lint findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectWorkspaceSuggestionNotes(): Promise<readonly string[]> {
            return [
              [
                "- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
                "- Keep ~/.openclaw out of git; it contains credentials and session history.",
              ].join("\n"),
              "Memory system not found in workspace.",
            ];
          },
        }),
      ),
      "core/doctor/workspace-suggestions",
    );
    const note = vi.fn();

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-test-workspace",
          },
        },
      },
      cwd: "/tmp/openclaw-test-workspace",
      doctor: { note },
    });

    expect(findings).toEqual([]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Tip: back up the workspace in a private git repo"),
      "Workspace",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Memory system not found in workspace."),
      "Workspace",
    );
  });

  it("returns workspace suggestions as info lint findings when no doctor note sink is provided", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectWorkspaceSuggestionNotes(): Promise<readonly string[]> {
            return [
              [
                "- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
                "- Keep ~/.openclaw out of git; it contains credentials and session history.",
              ].join("\n"),
              "Memory system not found in workspace.",
            ];
          },
        }),
      ),
      "core/doctor/workspace-suggestions",
    );

    const findings = await check.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-test-workspace",
          },
        },
      },
      cwd: "/tmp/openclaw-test-workspace",
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/workspace-suggestions",
        severity: "info",
        message: "Tip: back up the workspace in a private git repo (GitHub or GitLab).",
        fixHint: "- Keep ~/.openclaw out of git; it contains credentials and session history.",
      }),
      expect.objectContaining({
        checkId: "core/doctor/workspace-suggestions",
        severity: "info",
        message: "Memory system not found in workspace.",
      }),
    ]);
  });

  it("keeps optional shell completion installs out of doctor lint", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/shell-completion");

    await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {},
    });

    expect(detectShellCompletionHealth).toHaveBeenCalledWith({ nonInteractive: true });
  });

  it("previews configured plugin install repairs without installing packages", async () => {
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/configured-plugin-installs",
    );
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
          },
        },
      },
      meta: {
        lastTouchedVersion: "2026.5.1",
      },
    };

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg,
        env: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/configured-plugin-installs",
        path: expect.stringContaining("plugins:codex"),
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg,
        dryRun: true,
        diff: true,
        env: {},
        doctor: {
          sourceLastTouchedVersion: "2026.5.1",
        },
      },
      [
        {
          checkId: "core/doctor/configured-plugin-installs",
          severity: "warning",
          message: "needs repair",
        },
      ],
    );

    expect(repaired?.config).toBeUndefined();
    expect(repaired?.changes).toContain("Would repair configured plugin install(s): codex.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "package",
        action: "would-install-configured-plugin",
        target: "codex",
        dryRunSafe: false,
      }),
    );
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "would-stamp-configured-plugin-install-release",
        target: "meta.lastTouchedVersion",
      }),
    );
    expect(repaired?.diffs).toContainEqual(
      expect.objectContaining({
        kind: "config",
        path: "meta",
        after: expect.stringContaining("<doctor-run timestamp>"),
      }),
    );
  });

  it("does not lint configured plugin installs when the release repair already ran", async () => {
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/configured-plugin-installs",
    );

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          plugins: {
            entries: {
              codex: {
                enabled: true,
              },
            },
          },
          meta: {
            lastTouchedVersion: "2026.5.2-beta.1",
          },
        },
        env: {},
      }),
    ).resolves.toStrictEqual([]);
  });

  it("detects sandbox registry files and previews sharded migration", async () => {
    sandboxMocks.detectSandboxRegistryFileIssues.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/sandbox/registry-files",
    );

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox/registry-files",
        path: "/tmp/openclaw/sandbox/containers.json",
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        dryRun: true,
      },
      [],
    );

    expect(sandboxMocks.migrateLegacySandboxRegistryFiles).not.toHaveBeenCalled();
    expect(repaired?.changes).toContain(
      "Would migrate legacy sandbox containers registry /tmp/openclaw/sandbox/containers.json into sharded registry files.",
    );
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "state",
        action: "would-migrate-legacy-sandbox-registry",
        target: "/tmp/openclaw/sandbox/containers.json",
      }),
    );
  });

  it("detects sandbox image readiness and previews build side effects", async () => {
    sandboxMocks.detectSandboxImageIssues.mockResolvedValue([
      {
        kind: "missing-image",
        imageKind: "base",
        image: "openclaw/sandbox:local",
        path: "agents.defaults.sandbox.docker.image",
        buildScript: "scripts/sandbox-setup.sh",
        message: "Sandbox base image missing: openclaw/sandbox:local.",
        fixHint: "Build it with scripts/sandbox-setup.sh.",
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox/images");

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox/images",
        path: "agents.defaults.sandbox.docker.image",
      }),
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        dryRun: true,
      },
      [],
    );

    expect(repaired?.changes).toContain(
      "Would build or pull missing sandbox base image openclaw/sandbox:local with scripts/sandbox-setup.sh.",
    );
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "process",
        action: "would-build-sandbox-base-image",
        target: "openclaw/sandbox:local",
        dryRunSafe: false,
      }),
    );
  });

  it("preserves sandbox operator guidance for non-repairable image issues", async () => {
    sandboxMocks.detectSandboxImageIssues.mockResolvedValue([
      {
        kind: "docker-unavailable",
        mode: "all",
        path: "agents.defaults.sandbox.mode",
        message: 'Sandbox mode is enabled (mode: "all") but Docker is not available.',
        fixHint: "Install Docker and restart the gateway, or disable sandbox mode.",
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox/images");

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      },
      [],
    );

    expect(repaired).toMatchObject({
      status: "skipped",
      reason: "sandbox image issue needs operator action",
      warnings: [
        'Sandbox mode is enabled (mode: "all") but Docker is not available. Install Docker and restart the gateway, or disable sandbox mode.',
      ],
    });
  });

  it("leaves custom missing sandbox images as operator guidance", async () => {
    sandboxMocks.detectSandboxImageIssues.mockResolvedValue([
      {
        kind: "missing-image",
        imageKind: "base",
        image: "registry.example.com/openclaw/sandbox:custom",
        path: "agents.defaults.sandbox.docker.image",
        message: "Sandbox base image missing: registry.example.com/openclaw/sandbox:custom.",
        fixHint: "Build or pull it first.",
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox/images");

    const dryRun = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        dryRun: true,
      },
      [],
    );
    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      },
      [],
    );

    expect(dryRun?.changes).toEqual([
      "Would leave sandbox image issue for operator action: Sandbox base image missing: registry.example.com/openclaw/sandbox:custom.",
    ]);
    expect(dryRun?.effects).toContainEqual(
      expect.objectContaining({
        kind: "other",
        action: "would-inspect-sandbox-images",
        target: "agents.defaults.sandbox.docker.image",
      }),
    );
    expect(repaired).toMatchObject({
      status: "skipped",
      reason: "sandbox image issue needs operator action",
      changes: [],
      warnings: [
        "Sandbox base image missing: registry.example.com/openclaw/sandbox:custom. Build or pull it first.",
      ],
    });
  });

  it("detects sandbox shared-scope ignored overrides as read-only findings", async () => {
    sandboxMocks.collectSandboxScopeWarnings.mockReturnValue([
      {
        agentId: "work",
        overrides: ["docker"],
        path: "agents.list.work.sandbox",
        message: 'agents.list (id "work") sandbox docker overrides ignored.',
        fixHint: 'scope resolves to "shared".',
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox-scope");

    expect(check?.repair).toBeUndefined();
    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox-scope",
        path: "agents.list.work.sandbox",
        message: 'agents.list (id "work") sandbox docker overrides ignored.',
      }),
    );
  });

  it("detects extra gateway services as structured findings", async () => {
    gatewayServiceMocks.detectExtraGatewayServices.mockResolvedValue({
      services: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      legacyServices: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      cleanupHints: [],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/extra",
    );

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "warning",
        path: "openclaw-gateway-old.service",
      }),
    );
  });

  it("previews gateway service config repairs as service effects", async () => {
    gatewayServiceMocks.detectGatewayServiceConfigIssues.mockResolvedValue({
      status: "issue",
      serviceRewriteBlocked: false,
      issues: [
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/config",
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: { gateway: { port: 18888 } },
        dryRun: true,
      },
      [],
    );

    expect(repaired?.changes).toContain(
      "Would update gateway service config for Gateway service port does not match current gateway config. (18789 -> 18888).",
    );
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "service",
        action: "would-update-gateway-service-config",
        target: "openclaw-gateway",
        dryRunSafe: false,
      }),
    );
  });

  it("reports blocked gateway service rewrites as structured findings", async () => {
    gatewayServiceMocks.detectGatewayServiceConfigIssues.mockResolvedValue({
      status: "issue",
      serviceRewriteBlocked: true,
      issues: [],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/config",
    );

    await expect(
      check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/config",
        message:
          "Gateway service is running; command/entrypoint rewrites are blocked for this doctor pass.",
      }),
    );
    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg: {},
        },
        [],
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      warnings: ["Gateway service is running; leaving supervisor metadata unchanged."],
    });
  });

  it("does not promise unrepairable legacy gateway services during dry-run", async () => {
    gatewayServiceMocks.detectExtraGatewayServices.mockResolvedValue({
      services: [
        {
          label: "openclaw-gateway-system.service",
          scope: "system",
          detail: "systemd:system",
          platform: "linux",
          legacy: true,
        },
      ],
      legacyServices: [
        {
          label: "openclaw-gateway-system.service",
          scope: "system",
          detail: "systemd:system",
          platform: "linux",
          legacy: true,
        },
      ],
      cleanupHints: [],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/extra",
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg: {},
          dryRun: true,
        },
        [],
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      changes: [],
      warnings: [
        "Would skip legacy gateway service cleanup: openclaw-gateway-system.service (system).",
      ],
    });
  });

  it("validates gateway extra-service cleanup with detect-after", async () => {
    const detected = {
      services: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      legacyServices: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      cleanupHints: [],
    };
    gatewayServiceMocks.detectExtraGatewayServices
      .mockResolvedValueOnce(detected)
      .mockResolvedValueOnce(detected)
      .mockResolvedValueOnce({
        services: [],
        legacyServices: [],
        cleanupHints: [],
      });
    gatewayServiceMocks.repairExtraGatewayServices.mockResolvedValueOnce({
      removed: ["openclaw-gateway-old.service"],
      failed: [],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/extra",
    );

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      },
      { checks: [check!] },
    );

    expect(gatewayServiceMocks.repairExtraGatewayServices).toHaveBeenCalledTimes(1);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "service",
        action: "remove-legacy-gateway-service",
        target: "openclaw-gateway-old.service",
      }),
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("does not report gateway removal effects when cleanup removes nothing", async () => {
    const detected = {
      services: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      legacyServices: [
        {
          label: "openclaw-gateway-old.service",
          scope: "user",
          detail: "systemd:user",
          platform: "linux",
          legacy: true,
        },
      ],
      cleanupHints: [],
    };
    gatewayServiceMocks.detectExtraGatewayServices.mockResolvedValue(detected);
    gatewayServiceMocks.repairExtraGatewayServices.mockResolvedValueOnce({
      removed: [],
      failed: [],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/extra",
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      },
      [
        {
          checkId: "core/doctor/gateway-services/extra",
          severity: "warning",
          message: "legacy service remains",
        },
      ],
    );

    expect(repaired?.changes).toEqual([
      "Checked legacy gateway service openclaw-gateway-old.service for removal.",
    ]);
    expect(repaired?.status).toBe("skipped");
    expect(repaired?.reason).toBe("no legacy gateway services were removed");
    expect(repaired?.effects ?? []).toEqual([]);
  });

  it("reports blocked gateway service config repairs as skipped", async () => {
    gatewayServiceMocks.detectGatewayServiceConfigIssues.mockResolvedValueOnce({
      status: "issue",
      serviceRewriteBlocked: true,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint does not match the current install.",
          detail: "/old/openclaw -> /new/openclaw",
          level: "recommended",
        },
      ],
    });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/config",
    );

    const repaired = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: { gateway: {} },
      },
      [],
    );

    expect(gatewayServiceMocks.repairGatewayServiceConfig).not.toHaveBeenCalled();
    expect(repaired).toMatchObject({
      status: "skipped",
      reason: "gateway service rewrite is blocked while the service is running",
      changes: [],
      effects: [],
    });
  });

  it("validates gateway service config repair with detect-after", async () => {
    const drift = {
      status: "issue",
      serviceRewriteBlocked: false,
      issues: [
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    };
    gatewayServiceMocks.detectGatewayServiceConfigIssues
      .mockResolvedValueOnce(drift)
      .mockResolvedValueOnce(drift)
      .mockResolvedValueOnce({
        status: "clean",
        issues: [],
      });
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/gateway-services/config",
    );

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: { gateway: { port: 18888 } },
      },
      { checks: [check!] },
    );

    expect(gatewayServiceMocks.repairGatewayServiceConfig).toHaveBeenCalledTimes(1);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "service",
        action: "update-gateway-service-config",
        target: "openclaw-gateway",
      }),
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("validates configured plugin install repairs against repaired config metadata", async () => {
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/configured-plugin-installs",
    );

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime: { log() {}, error() {}, exit() {} },
          cfg: {
            meta: {
              lastTouchedVersion: "2026.5.2-beta.1",
            },
          },
          doctor: {
            sourceLastTouchedVersion: "2026.5.1",
          },
          env: {},
        },
        {
          findings: [
            {
              checkId: "core/doctor/configured-plugin-installs",
              severity: "warning",
              message: "needs repair",
              path: "meta.lastTouchedVersion",
            },
          ],
        },
      ),
    ).resolves.toStrictEqual([]);
  });

  it("validates legacy plugin manifest repair with detect-after", async () => {
    const trustedRoot = join(process.cwd(), "dist", "extensions");
    await fs.mkdir(trustedRoot, { recursive: true });
    tmp = await fs.mkdtemp(join(trustedRoot, "openclaw-health-plugin-manifest-"));
    const pluginRoot = join(tmp, "openai");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(
      join(pluginRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@openclaw/test-plugin",
          version: "1.0.0",
          openclaw: {
            extensions: ["./index.ts"],
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(join(pluginRoot, "index.ts"), "export default {};\n");
    await fs.writeFile(
      join(pluginRoot, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: "openai",
          providers: ["openai"],
          speechProviders: ["openai"],
          configSchema: { type: "object" },
        },
        null,
        2,
      )}\n`,
    );
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/legacy-plugin-manifests",
    );

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          plugins: {
            load: {
              paths: [tmp],
            },
          },
        },
        cwd: tmp,
        env: {},
      },
      { checks: [check!] },
    );

    const manifest = JSON.parse(
      await fs.readFile(join(pluginRoot, "openclaw.plugin.json"), "utf-8"),
    ) as { speechProviders?: string[]; contracts?: Record<string, string[]> };
    expect(manifest.speechProviders).toBeUndefined();
    expect(manifest.contracts?.speechProviders).toEqual(["openai"]);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("repairs legacy plugin manifests from direct manifest load paths", async () => {
    const trustedRoot = join(process.cwd(), "dist", "extensions");
    await fs.mkdir(trustedRoot, { recursive: true });
    tmp = await fs.mkdtemp(join(trustedRoot, "openclaw-health-plugin-manifest-file-"));
    const pluginRoot = join(tmp, "openai");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(
      join(pluginRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@openclaw/test-plugin",
          version: "1.0.0",
          openclaw: {
            extensions: ["./index.ts"],
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(join(pluginRoot, "index.ts"), "export default {};\n");
    const manifestPath = join(pluginRoot, "openclaw.plugin.json");
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          id: "openai",
          speechProviders: ["openai"],
          configSchema: { type: "object" },
        },
        null,
        2,
      )}\n`,
    );
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/legacy-plugin-manifests",
    );

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          plugins: {
            load: {
              paths: [manifestPath],
            },
          },
        },
        cwd: tmp,
        env: {},
      },
      { checks: [check!] },
    );

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      speechProviders?: string[];
      contracts?: Record<string, string[]>;
    };
    expect(manifest.speechProviders).toBeUndefined();
    expect(manifest.contracts?.speechProviders).toEqual(["openai"]);
    expect(result.checksRepaired).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("validates plugin registry repairs with detect-after", async () => {
    pluginRegistryMocks.detectPluginRegistryStateIssues
      .mockResolvedValueOnce([
        {
          kind: "migration",
          filePath: "/tmp/openclaw/plugin-registry.json",
          action: "migrate",
        },
      ])
      .mockResolvedValueOnce([]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/plugin-registry");

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        env: {},
      },
      { checks: [check!] },
    );

    expect(pluginRegistryMocks.repairPluginRegistryState).toHaveBeenCalledTimes(1);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "state",
        action: "refresh-plugin-registry",
        target: "/tmp/openclaw/plugin-registry.json",
      }),
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("runs positional plugin registry repair without healthy skipped warnings", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/plugin-registry");

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        env: {},
      },
      { checks: [check!] },
    );

    expect(pluginRegistryMocks.repairPluginRegistryState).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "state",
        action: "refresh-plugin-registry",
        target: "installed plugin registry",
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.remainingFindings).toEqual([]);
  });

  it("previews positional plugin registry refresh during dry-run", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/plugin-registry");

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        env: {},
      },
      { checks: [check!], dryRun: true },
    );

    expect(pluginRegistryMocks.repairPluginRegistryState).not.toHaveBeenCalled();
    expect(result.changes).toEqual(["Would rebuild plugin registry."]);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "state",
        action: "would-refresh-plugin-registry",
        target: "installed plugin registry",
      }),
    );
  });

  it("scopes plugin registry repair to supplied findings", async () => {
    pluginRegistryMocks.detectPluginRegistryStateIssues.mockResolvedValue([
      {
        kind: "migration",
        filePath: "/tmp/openclaw/plugin-registry.json",
        action: "migrate",
      },
      {
        kind: "managed-npm-peer-link",
        packageName: "@openclaw/slack",
        reason: "missing OpenClaw host link",
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/plugin-registry");

    const result = await check?.repair?.(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
        env: {},
      },
      [
        {
          checkId: "core/doctor/plugin-registry",
          severity: "warning",
          message: "Managed npm plugin package has a broken OpenClaw host peer link.",
          path: "@openclaw/slack",
        },
      ],
    );

    expect(pluginRegistryMocks.repairPluginRegistryState).toHaveBeenCalledWith(expect.any(Object), [
      {
        kind: "managed-npm-peer-link",
        packageName: "@openclaw/slack",
        reason: "missing OpenClaw host link",
      },
    ]);
    expect(result?.effects).toEqual([
      expect.objectContaining({
        kind: "package",
        action: "repair-openclaw-peer-link",
        target: "@openclaw/slack",
      }),
    ]);
  });

  it("validates sandbox registry repairs with detect-after", async () => {
    const issue = {
      kind: "containers",
      registryPath: "/tmp/openclaw/sandbox/containers.json",
      shardedDir: "/tmp/openclaw/sandbox/containers",
      exists: true,
      valid: true,
      entries: 2,
    };
    sandboxMocks.detectSandboxRegistryFileIssues
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([]);
    sandboxMocks.migrateLegacySandboxRegistryFiles.mockResolvedValueOnce([
      {
        kind: "containers",
        registryPath: issue.registryPath,
        shardedDir: issue.shardedDir,
        status: "migrated",
        entries: 2,
      },
    ]);
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/sandbox/registry-files",
    );

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {},
      },
      { checks: [check!] },
    );

    expect(sandboxMocks.migrateLegacySandboxRegistryFiles).toHaveBeenCalledTimes(1);
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "state",
        action: "migrate-legacy-sandbox-registry",
        target: issue.registryPath,
      }),
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("validates sandbox image repairs with detect-after", async () => {
    const issue = {
      kind: "missing-image",
      imageKind: "base",
      image: "openclaw/sandbox:local",
      path: "agents.defaults.sandbox.docker.image",
      buildScript: "scripts/sandbox-setup.sh",
      message: "Sandbox base image missing: openclaw/sandbox:local.",
      fixHint: "Build it with scripts/sandbox-setup.sh.",
    };
    sandboxMocks.detectSandboxImageIssues
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([]);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
          },
        },
      },
    };
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox/images");

    const result = await runDoctorHealthRepairs(
      {
        mode: "fix",
        runtime: { log() {}, error() {}, exit() {} },
        cfg,
      },
      { checks: [check!] },
    );

    expect(sandboxMocks.repairSandboxImages).toHaveBeenCalledTimes(1);
    expect(sandboxMocks.repairSandboxImages).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        prompter: expect.objectContaining({
          note: expect.any(Function),
        }),
      }),
    );
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "process",
        action: "build-sandbox-base-image",
        target: "openclaw/sandbox:local",
      }),
    );
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
  });

  it("previews converted side-effect repairs as effects without fake diffs", async () => {
    const runtime = { log() {}, error() {}, exit() {} };
    const cases = [
      {
        id: "core/doctor/shell-completion",
        expectedAction: "would-repair-shell-completion",
      },
      {
        id: "core/doctor/startup-channel-maintenance",
        expectedAction: "would-run-channel-startup-maintenance",
      },
      {
        id: "core/doctor/systemd-linger",
        expectedAction: "would-enable-systemd-linger",
      },
    ];

    for (const entry of cases) {
      const check = CORE_HEALTH_CHECKS.find((candidate) => candidate.id === entry.id);
      const result = await check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg: {},
          dryRun: true,
          diff: true,
        },
        [
          {
            checkId: entry.id,
            severity: "warning",
            message: "needs repair",
          },
        ],
      );

      expect(result?.changes).toHaveLength(1);
      expect(result?.effects).toContainEqual(
        expect.objectContaining({
          action: entry.expectedAction,
          dryRunSafe: false,
        }),
      );
      expect(result?.diffs ?? []).toEqual([]);
    }
  });
});
