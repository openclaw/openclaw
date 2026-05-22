import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { defineSplitHealthCheck } from "./health-check-adapter.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";
import type { RegisteredHealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };
type SplitCompatHealthCheck = RegisteredHealthCheck & {
  detect: NonNullable<RegisteredHealthCheck["detect"]>;
  repair?: NonNullable<RegisteredHealthCheck["repair"]>;
};

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

function getCheck(checks: readonly RegisteredHealthCheck[], id: string): SplitCompatHealthCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check?.detect) {
    throw new Error(`Missing health check ${id}`);
  }
  return check as SplitCompatHealthCheck;
}

const detectShellCompletionHealth = vi.hoisted(() =>
  vi.fn<() => Promise<readonly import("./health-checks.js").HealthFinding[]>>(async () => []),
);
const doctorCoreCheckMocks = vi.hoisted(() => ({
  loadBundledPluginPublicSurfaceModuleSync: vi.fn(),
  noteClaudeCliHealth: vi.fn(),
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

describe("registerCoreHealthChecks", () => {
  beforeEach(() => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
    doctorCoreCheckMocks.loadBundledPluginPublicSurfaceModuleSync.mockReset();
    doctorCoreCheckMocks.noteClaudeCliHealth.mockReset();
  });

  it("registers the built-in health checks once", () => {
    registerCoreHealthChecks();
    registerCoreHealthChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual(
      CORE_HEALTH_CHECKS.map((check) => check.id),
    );
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerHealthCheck(defineSplitHealthCheck({
      id: "core/doctor/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    }));

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

    await check?.run?.({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {},
      repair: false,
    });

    expect(detectShellCompletionHealth).toHaveBeenCalledWith({ nonInteractive: true });
  });

  it("previews converted side-effect repairs as effects without fake diffs", async () => {
    const runtime = { log() {}, error() {}, exit() {} };
    detectShellCompletionHealth.mockResolvedValue([
      {
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: "Shell completion cache is missing.",
      },
    ]);
    const cases = [
      {
        id: "core/doctor/shell-completion",
        expectedAction: "would-repair-shell-completion",
      },
      {
        id: "core/doctor/startup-channel-maintenance",
        expectedAction: "would-run-channel-startup-maintenance",
      },
    ];

    for (const entry of cases) {
      const check = CORE_HEALTH_CHECKS.find((candidate) => candidate.id === entry.id);
      const repairCtx = {
        mode: "fix" as const,
        runtime,
        cfg: {},
        repair: false,
      };
      const result = await check?.run(repairCtx);

      expect(result?.changes).toHaveLength(1);
      expect(result?.effects).toContainEqual(
        expect.objectContaining({
          action: entry.expectedAction,
        }),
      );
      expect(result?.diffs ?? []).toEqual([]);
    }
  });
});
