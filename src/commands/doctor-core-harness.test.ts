import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import {
  buildCoreHarnessSummary,
  formatCoreHarnessSummary,
  isIsolatedCodexHome,
  noteCoreHarnessSummary,
  resolveCoreHarnessHome,
  resolveCoreHarnessJsonExitCode,
} from "./doctor-core-harness.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

describe("Core Harness doctor summary", () => {
  beforeEach(() => {
    note.mockClear();
  });

  const approvals: ExecApprovalsFile = {
    version: 1,
    agents: {
      main: {
        allowlist: [
          { pattern: "=command:abc123", source: "allow-always" },
          { pattern: "git status", lastUsedAt: 1 },
        ],
      },
    },
  };

  const readWrapper = (body: string) => ({
    existsSync: () => true,
    readFileSync: () => body,
  });

  it("downgrades the isolated-home warning to warn when OPENCLAW_HOME points at a non-isolated path", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {},
      configPath: "/tmp/codex-home/.openclaw/openclaw.json",
      env: {
        HOME: "/tmp/codex-home",
        OPENCLAW_HOME: "/Users/hide_aibo",
      } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
    });

    expect(isIsolatedCodexHome("/tmp/codex-home")).toBe(true);
    const isolated = summary.warnings.find((w) => w.code === "core-harness.home.isolated");
    expect(isolated?.severity).toBe("warn");
    expect(isolated?.what_to_do_now).toContain("OPENCLAW_HOME");
  });

  it("does not emit the isolated-home warning when OPENCLAW_HOME is unset and effective home == HOME", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {},
      configPath: "/tmp/codex-home/.openclaw/openclaw.json",
      env: { HOME: "/tmp/codex-home" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
    });

    // OPENCLAW_HOME unset → effective home falls through to HOME → resolve
    // equality short-circuits the warning. Defensive `overrideIsIsolated`
    // would still pick error severity if this branch were reachable.
    expect(summary.warnings.find((w) => w.code === "core-harness.home.isolated")).toBeUndefined();
  });

  it("keeps the isolated-home warning at error severity when OPENCLAW_HOME is also isolated", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {},
      configPath: "/tmp/codex-home/.openclaw/openclaw.json",
      env: {
        HOME: "/tmp/codex-home",
        OPENCLAW_HOME: "/tmp/.codex/state",
      } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
    });

    const isolated = summary.warnings.find((w) => w.code === "core-harness.home.isolated");
    expect(isolated?.severity).toBe("error");
  });

  it("uses HOME as the effective home when OPENCLAW_HOME is not set", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {
        commands: {
          ownerAllowFrom: ["discord:123"],
        },
      } as OpenClawConfig,
      configPath: "/Users/kitahara/.openclaw/openclaw.json",
      env: { HOME: "/Users/kitahara" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      existsSync: (candidate) => candidate === "/Users/kitahara/.local/bin/oc-wrapper-lib",
      readFileSync: () => "openclaw-setup resolve_openclaw_home OPENCLAW_HOME",
    });

    expect(summary.effectiveHome).toMatchObject({
      path: "/Users/kitahara",
      source: "home",
    });
    expect(summary.wrappers).toEqual({
      openclawSetupAlias: true,
      homeResolver: true,
    });
  });

  it("looks up wrapper under OS user home, not OPENCLAW_HOME, when they differ", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {
        commands: { ownerAllowFrom: ["discord:123"] },
      } as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: {
        HOME: "/Users/hide_aibo",
        OPENCLAW_HOME: "/Users/hide_aibo/.openclaw",
      } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      existsSync: (candidate) => candidate === "/Users/hide_aibo/.local/bin/oc-wrapper-lib",
      readFileSync: () => "openclaw-setup resolve_openclaw_home OPENCLAW_HOME",
    });

    expect(summary.effectiveHome).toMatchObject({
      path: "/Users/hide_aibo/.openclaw",
      source: "env",
    });
    expect(summary.wrappers).toEqual({
      openclawSetupAlias: true,
      homeResolver: true,
    });
  });

  it("downgrades wrapper warnings to info when the wrapper file is missing entirely", () => {
    const summary = buildCoreHarnessSummary({
      cfg: { commands: { ownerAllowFrom: ["discord:123"] } } as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      existsSync: () => false,
      readFileSync: () => "",
    });

    const aliasMissing = summary.warnings.find(
      (w) => w.code === "core-harness.wrapper.openclaw-setup-alias-missing",
    );
    const resolverMissing = summary.warnings.find(
      (w) => w.code === "core-harness.wrapper.home-resolver-missing",
    );
    expect(aliasMissing?.severity).toBe("info");
    expect(resolverMissing?.severity).toBe("info");
    expect(aliasMissing?.summary.toLowerCase()).toContain("not detected");
  });

  it("keeps wrapper warnings at warn when the wrapper file exists but content is incomplete", () => {
    const summary = buildCoreHarnessSummary({
      cfg: { commands: { ownerAllowFrom: ["discord:123"] } } as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      existsSync: () => true,
      readFileSync: () => "",
    });

    const aliasMissing = summary.warnings.find(
      (w) => w.code === "core-harness.wrapper.openclaw-setup-alias-missing",
    );
    const resolverMissing = summary.warnings.find(
      (w) => w.code === "core-harness.wrapper.home-resolver-missing",
    );
    expect(aliasMissing?.severity).toBe("warn");
    expect(resolverMissing?.severity).toBe("warn");
  });

  it("still honors explicit wrapperPath overrides for tests and tooling", () => {
    const summary = buildCoreHarnessSummary({
      cfg: {} as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      wrapperPath: "/explicit/path/oc-wrapper-lib",
      existsSync: (candidate) => candidate === "/explicit/path/oc-wrapper-lib",
      readFileSync: () => "openclaw-setup resolve_openclaw_home OPENCLAW_HOME",
    });

    expect(summary.wrappers).toEqual({
      openclawSetupAlias: true,
      homeResolver: true,
    });
  });

  it("tracks whether effective home came from OPENCLAW_HOME, USERPROFILE, or os.homedir", () => {
    expect(
      resolveCoreHarnessHome({
        HOME: "/Users/ignored",
        OPENCLAW_HOME: "~/openclaw-home",
      } as NodeJS.ProcessEnv).source,
    ).toBe("env");
    expect(
      resolveCoreHarnessHome({
        USERPROFILE: "/Users/profile",
      } as NodeJS.ProcessEnv).source,
    ).toBe("userprofile");
    expect(resolveCoreHarnessHome({} as NodeJS.ProcessEnv, () => "/Users/os-home").source).toBe(
      "os-homedir",
    );
  });

  it("reports wrapper coverage, broad Discord elevated allowFrom, and approval drift", () => {
    const cfg = {
      tools: {
        elevated: {
          allowFrom: {
            discord: ["*"],
          },
        },
      },
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
            scope: "shared",
            workspaceAccess: "rw",
          },
        },
      },
      commands: {
        ownerAllowFrom: ["discord:123"],
      },
    } as OpenClawConfig;

    const summary = buildCoreHarnessSummary({
      cfg,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals,
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
    });

    expect(summary.wrappers.openclawSetupAlias).toBe(true);
    expect(summary.wrappers.homeResolver).toBe(true);
    expect(summary.elevated.wildcardAllowFrom).toEqual(["tools.elevated.allowFrom.discord"]);
    expect(summary.approvals).toMatchObject({
      totalEntries: 2,
      allowAlwaysEntries: 1,
      opaqueCommandEntries: 1,
    });
    expect(summary.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "core-harness.elevated.allow-from-wildcard",
        "core-harness.exec-approvals.drift",
        "core-harness.sandbox-explain.resolver-followup",
      ]),
    );
  });

  it("surfaces startup integrity issues as warnings when provided", () => {
    const summary = buildCoreHarnessSummary({
      cfg: { commands: { ownerAllowFrom: ["discord:123"] } } as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
      startupIssues: {
        packageRootResolved: false,
        sourceInstallIssues: [
          "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
        ],
      },
    });

    const codes = summary.warnings.map((warning) => warning.code);
    expect(codes).toContain("core-harness.startup.broken-shim");
    expect(codes).toContain("core-harness.startup.broken-root");
    const shim = summary.warnings.find((w) => w.code === "core-harness.startup.broken-shim");
    expect(shim?.severity).toBe("error");
    const root = summary.warnings.find((w) => w.code === "core-harness.startup.broken-root");
    expect(root?.severity).toBe("warn");
    expect(root?.what_to_do_now).toContain("pnpm install");
  });

  it("omits startup integrity warnings when none are reported", () => {
    const summary = buildCoreHarnessSummary({
      cfg: { commands: { ownerAllowFrom: ["discord:123"] } } as OpenClawConfig,
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper("openclaw-setup resolve_openclaw_home OPENCLAW_HOME"),
      startupIssues: {
        packageRootResolved: true,
        sourceInstallIssues: [],
      },
    });

    const codes = summary.warnings.map((warning) => warning.code);
    expect(codes).not.toContain("core-harness.startup.broken-shim");
    expect(codes).not.toContain("core-harness.startup.broken-root");
  });

  it("emits a human-readable Core Harness Summary note", () => {
    const summary = noteCoreHarnessSummary({
      cfg: {},
      configPath: "/Users/hide_aibo/.openclaw/openclaw.json",
      env: { HOME: "/Users/hide_aibo" } as NodeJS.ProcessEnv,
      approvals: { version: 1 },
      ...readWrapper(""),
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Effective OpenClaw home"),
      "Core Harness Summary",
    );
    expect(formatCoreHarnessSummary(summary)).toContain("Warnings:");
  });

  it("maps Core Harness JSON exit codes from config validity and warning severity", () => {
    expect(
      resolveCoreHarnessJsonExitCode({
        sourceConfigValid: false,
        summary: { warnings: [] },
      }),
    ).toBe(2);
    expect(
      resolveCoreHarnessJsonExitCode({
        sourceConfigValid: true,
        summary: {
          warnings: [
            {
              code: "core-harness.home.isolated",
              severity: "error",
              category: "new",
              summary: "isolated",
              what_to_do_now: "fix",
              safe_to_ignore_today: false,
            },
          ],
        },
      }),
    ).toBe(3);
    expect(
      resolveCoreHarnessJsonExitCode({
        sourceConfigValid: true,
        summary: {
          warnings: [
            {
              code: "core-harness.exec-approvals.drift",
              severity: "warn",
              category: "existing-consolidate",
              summary: "drift",
              what_to_do_now: "review",
              safe_to_ignore_today: false,
            },
          ],
        },
      }),
    ).toBe(1);
    expect(
      resolveCoreHarnessJsonExitCode({
        sourceConfigValid: true,
        summary: {
          warnings: [
            {
              code: "core-harness.sandbox-explain.resolver-followup",
              severity: "info",
              category: "resolver-bug-followup",
              summary: "follow-up",
              what_to_do_now: "later",
              safe_to_ignore_today: true,
            },
          ],
        },
      }),
    ).toBe(0);
  });
});
