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

  it("detects isolated process homes and keeps a Japanese next action", () => {
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
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({
        code: "core-harness.home.isolated",
        severity: "error",
        what_to_do_now: expect.stringContaining("OPENCLAW_HOME"),
      }),
    );
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
