import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";
import {
  buildTerminalEnv,
  createTerminalLaunchPolicy,
  resolveTerminalSpawnPlan,
} from "./launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const disabled: OpenClawConfig = { gateway: { terminal: { enabled: false } } };
const enabled: OpenClawConfig = { gateway: { terminal: { enabled: true } } };
const hot = { restartPending: false };
const restart = { restartPending: true };
const acceptHot = { retireRejectedRestart: false };
const retireRestart = { retireRejectedRestart: true };
function terminalConfig(
  terminal: NonNullable<NonNullable<OpenClawConfig["gateway"]>["terminal"]>,
  port?: number,
): OpenClawConfig {
  return { gateway: { terminal, ...(port === undefined ? {} : { port }) } };
}
const shellConfig = (shell: string) => terminalConfig({ enabled: true, shell });
function fleetConfig(blocked?: "alpha" | "beta"): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: {
        alpha: blocked === "alpha" ? { sandbox: { mode: "all" } } : {},
        beta: blocked === "beta" ? { sandbox: { mode: "all" } } : {},
      },
    },
  };
}
const sandboxConfig = (mode: "all" | "off"): OpenClawConfig => ({
  ...enabled,
  agents: { defaults: { sandbox: { mode } } },
});
function expectDisabled(policy: ReturnType<typeof createTerminalLaunchPolicy>) {
  expect(policy.isEnabled()).toBe(false);
  expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
}
function expectShell(policy: ReturnType<typeof createTerminalLaunchPolicy>, shell: string) {
  expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell } });
}

describe("createTerminalLaunchPolicy", () => {
  it("is enabled by default and fails closed when disabled, sandboxed, or unknown-agent", () => {
    expect(createTerminalLaunchPolicy({}).isEnabled()).toBe(true);
    expectDisabled(createTerminalLaunchPolicy(disabled));

    const sandboxed = createTerminalLaunchPolicy(sandboxConfig("all"));
    expect(sandboxed.resolve()).toMatchObject({
      ok: false,
      block: { kind: "sandboxed", mode: "all" },
    });

    const configured = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
      agents: { entries: { locked: { sandbox: { mode: "all" } } } },
    });
    expect(configured.resolve("ghost")).toEqual({
      ok: false,
      block: { kind: "unknown-agent", agentId: "ghost" },
    });
  });

  it("requires an explicit terminal owner in explicit multi-agent fleets", () => {
    const policy = createTerminalLaunchPolicy({
      agents: {
        ownership: "explicit",
        entries: { main: {}, research: {} },
      },
    });

    expect(policy.resolve()).toMatchObject({
      ok: false,
      block: {
        kind: "owner-required",
        message: expect.stringContaining("no explicit owner"),
      },
    });
    expect(policy.resolve("research")).toMatchObject({
      ok: true,
      plan: { agentId: "research" },
    });
  });

  it("applies restart-bound revocations without granting access early", () => {
    const initial = terminalConfig({ enabled: true }, 18789);
    const policy = createTerminalLaunchPolicy(initial);

    policy.prepareConfig(terminalConfig({ enabled: false }, 18790), restart);
    policy.prepareConfig(initial, restart);
    expectDisabled(policy);

    policy.prepareConfig(terminalConfig({ enabled: true, shell: "/bin/new-shell" }, 18790), hot);
    policy.commitConfig();
    policy.acceptConfig(acceptHot);
    expectDisabled(policy);

    const disabledPolicy = createTerminalLaunchPolicy(disabled);
    disabledPolicy.prepareConfig(initial, restart);
    expectDisabled(disabledPolicy);
  });

  it("preserves restart revocations across updates and isolates hot restrictions by agent", () => {
    const baseConfig: OpenClawConfig = fleetConfig();
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(fleetConfig("alpha"), restart);
    policy.prepareConfig(baseConfig, restart);
    policy.prepareConfig(fleetConfig("beta"), hot);

    expect(policy.resolve("alpha")).toMatchObject({ ok: false, block: { kind: "sandboxed" } });
    expect(policy.resolve("beta").ok).toBe(false);

    policy.acceptConfig(acceptHot);
    expect(policy.resolve("alpha").ok).toBe(false);
    expect(policy.resolve("beta").ok).toBe(true);

    policy.acceptConfig(retireRestart);
    expect(policy.resolve("alpha").ok).toBe(true);
  });

  it.each(["sandboxed", "unknown-agent"] as const)(
    "retains a pending %s restriction when hot-enabling an initially disabled terminal",
    (kind) => {
      const initial: OpenClawConfig = {
        ...disabled,
        agents: { ownership: "explicit", entries: { ops: {}, other: {} } },
      };
      const policy = createTerminalLaunchPolicy(initial);
      policy.prepareConfig(
        {
          gateway: { ...initial.gateway, port: 18790 },
          agents: {
            ...initial.agents,
            entries:
              kind === "sandboxed"
                ? { ops: { sandbox: { mode: "all" } }, other: {} }
                : { other: {} },
          },
        },
        restart,
      );
      policy.acceptConfig(acceptHot);
      policy.prepareConfig(
        { ...initial, gateway: { port: 18790, terminal: { enabled: true } } },
        hot,
      );
      policy.commitConfig();
      policy.acceptConfig(acceptHot);

      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve("ops")).toMatchObject({ ok: false, block: { kind } });
      expect(policy.resolve("other").ok).toBe(true);
    },
  );

  it.each([false, true])(
    "publishes shell changes only at hot commit with pending restart=%s",
    (restartPending) => {
      const initial = shellConfig("/bin/old-shell");
      const policy = createTerminalLaunchPolicy(initial);
      const originalLaunch = policy.resolve();
      if (restartPending) {
        policy.prepareConfig(
          terminalConfig({ enabled: true, shell: "/bin/new-shell" }, 18790),
          restart,
        );
        expectShell(policy, "/bin/old-shell");
      }
      const nextConfig = shellConfig("/bin/new-shell");
      policy.prepareConfig(nextConfig, hot);
      expectShell(policy, "/bin/old-shell");

      policy.commitConfig();
      expectShell(policy, "/bin/new-shell");
      expect(originalLaunch).toMatchObject({ ok: true, plan: { shell: "/bin/old-shell" } });

      policy.prepareConfig(terminalConfig({ shell: "/bin/rejected-shell" }), hot);
      policy.acceptConfig(acceptHot);
      policy.commitConfig();
      expectShell(policy, "/bin/new-shell");

      const defaults = createTerminalLaunchPolicy({}).resolve();
      policy.prepareConfig({}, hot);
      policy.commitConfig();
      expect(policy.resolve()).toEqual(defaults);
    },
  );

  it("does not grant a non-restart policy relaxation before commit", () => {
    const policy = createTerminalLaunchPolicy(sandboxConfig("all"));
    policy.prepareConfig(sandboxConfig("off"), hot);
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retires a failed hot restriction when the replacement restart is accepted", () => {
    const baseConfig: OpenClawConfig = sandboxConfig("off");
    const restartPolicy = createTerminalLaunchPolicy(baseConfig);
    restartPolicy.prepareConfig(sandboxConfig("all"), hot);
    restartPolicy.prepareConfig(baseConfig, restart);
    expect(restartPolicy.resolve().ok).toBe(false);
    restartPolicy.acceptConfig(acceptHot);
    restartPolicy.commitConfig();
    expect(restartPolicy.resolve().ok).toBe(true);
  });

  it.each(["all", "off"] as const)("publishes %s after retiring a rejected restart", (mode) => {
    const policy = createTerminalLaunchPolicy(mode === "all" ? enabled : sandboxConfig("all"));
    policy.prepareConfig(disabled, restart);
    policy.prepareConfig(sandboxConfig(mode), hot);
    policy.commitConfig();
    expectDisabled(policy);
    policy.acceptConfig(retireRestart);
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(true);
    expect(policy.resolve().ok).toBe(mode === "off");
  });

  it.each([
    ["off", false],
    ["all", false],
    ["off", true],
  ] as const)("retires an uncommitted hot candidate (base=%s, restart=%s)", (mode, pending) => {
    const base = sandboxConfig(mode);
    const policy = createTerminalLaunchPolicy(base);
    if (pending) {
      policy.prepareConfig(base, restart);
    }
    policy.prepareConfig(sandboxConfig(mode === "off" ? "all" : "off"), hot);
    expect(policy.resolve().ok).toBe(false);
    policy.acceptConfig(acceptHot);
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(mode === "off");
  });

  it("retains committed hot restrictions while a restart is pending", () => {
    const baseConfig = sandboxConfig("off");
    const appliedPendingPolicy = createTerminalLaunchPolicy(baseConfig);
    appliedPendingPolicy.prepareConfig(baseConfig, restart);
    appliedPendingPolicy.prepareConfig(sandboxConfig("all"), hot);
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig(acceptHot);
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(false);
    appliedPendingPolicy.prepareConfig(baseConfig, hot);
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig(acceptHot);
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(true);
  });

  it.each([false, true])(
    "commits hot enablement and keeps failed disable restrictions until commit with pending restart=%s",
    (restartPending) => {
      const policy = createTerminalLaunchPolicy(disabled);
      const port = restartPending ? 18790 : undefined;
      const disabledConfig = terminalConfig({ enabled: false }, port);
      const enabledConfig = terminalConfig({ enabled: true, shell: "/bin/sh" }, port);
      if (restartPending) {
        policy.prepareConfig(disabledConfig, restart);
        policy.acceptConfig(acceptHot);
      }
      policy.prepareConfig(enabledConfig, hot);
      expectDisabled(policy);

      policy.commitConfig();
      policy.acceptConfig(acceptHot);
      expect(policy.isEnabled()).toBe(true);
      expectShell(policy, "/bin/sh");

      policy.prepareConfig(disabledConfig, hot);
      expectDisabled(policy);
      // A failed disable cannot grant access through an uncommitted relaxation.
      policy.prepareConfig(enabledConfig, hot);
      expectDisabled(policy);
      policy.commitConfig();
      policy.acceptConfig(acceptHot);
      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve().ok).toBe(true);

      policy.prepareConfig(disabledConfig, hot);
      policy.commitConfig();
      policy.acceptConfig(acceptHot);
      expectDisabled(policy);
    },
  );
});

describe("buildTerminalEnv", () => {
  it.each([
    [
      { PATH: "/usr/bin", FOO: "bar" },
      {
        PATH: "/usr/bin",
        FOO: "bar",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        OPENCLAW_TERMINAL: "1",
      },
    ],
    [
      { FORCE_COLOR: "0", NO_COLOR: "1", COLORTERM: undefined },
      { FORCE_COLOR: "0", NO_COLOR: "1", COLORTERM: "truecolor" },
    ],
    [{ TERM: "screen-256color" }, { TERM: "screen-256color" }],
  ])("preserves environment controls and supplies terminal defaults %#", (baseEnv, expected) => {
    const original = { ...baseEnv };
    expect(buildTerminalEnv(baseEnv)).toMatchObject(expected);
    expect(baseEnv).toEqual(original);
  });

  it.each(["truecolor", "24bit", ""])("preserves explicit COLORTERM=%j", (colorterm) => {
    expect(buildTerminalEnv({ COLORTERM: colorterm }).COLORTERM).toBe(colorterm);
  });

  it.each(["COLORTERM", "ColorTerm", "colorterm"])(
    "preserves explicit Windows %s through catalog merging",
    (key) => {
      for (const value of ["truecolor", "24bit", "ansi", ""]) {
        const baseEnv = { [key]: value };
        const env = buildTerminalEnv(baseEnv, "win32");
        const merged = mergeProcessEnv([env], "win32");
        expect(resolveEnvironmentValue(merged, "COLORTERM", "win32")).toBe(value);
        expect(env[key]).toBe(value);
        expect(baseEnv).toEqual({ [key]: value });
      }
    },
  );

  it("keeps platform key semantics and catalog override precedence", () => {
    expect(buildTerminalEnv({}, "win32").COLORTERM).toBe("truecolor");
    expect(buildTerminalEnv({ colorterm: "ansi" }, "linux")).toMatchObject({
      COLORTERM: "truecolor",
      colorterm: "ansi",
    });
    const env = buildTerminalEnv({ ColorTerm: "24bit", colorterm: "ansi" }, "win32");
    expect(resolveEnvironmentValue(env, "COLORTERM", "win32")).toBe("24bit");
    const merged = mergeProcessEnv([env, { colorterm: "" }], "win32");
    expect(resolveEnvironmentValue(merged, "COLORTERM", "win32")).toBe("");
  });
});

describe("resolveTerminalSpawnPlan", () => {
  it("quotes every command argument for a login shell", () => {
    const plan = resolveTerminalSpawnPlan({
      agentId: "main",
      cwd: "/work",
      shell: "/bin/zsh",
      args: ["-l"],
      initialCommand: ["codex", "resume", "a b;$HOME", "it's"],
    });
    expect(plan).toMatchObject({
      shell: "/bin/zsh",
      args: ["-il", "-c", "'codex' 'resume' 'a b;$HOME' 'it'\"'\"'s'"],
    });
  });

  it("uses a valid cwd override and falls back to home for a missing override", () => {
    const cwd = tempDirs.make("terminal-resume-cwd-");
    const base = {
      agentId: "main",
      cwd: "/missing/base",
      shell: "/bin/sh",
      args: [],
      initialCommand: ["claude", "--resume", "id"],
    };
    expect(resolveTerminalSpawnPlan({ ...base, cwdOverride: cwd }).cwd).toBe(cwd);
    expect(
      resolveTerminalSpawnPlan(
        { ...base, cwdOverride: "/definitely/missing" },
        { env: { HOME: "/fallback/home" } },
      ).cwd,
    ).toBe("/fallback/home");
  });

  it("spawns the resume executable directly on Windows", () => {
    expect(
      resolveTerminalSpawnPlan(
        {
          agentId: "main",
          cwd: "/work",
          shell: "cmd.exe",
          args: [],
          initialCommand: ["codex.exe", "resume", "thread"],
        },
        { platform: "win32" },
      ),
    ).toMatchObject({ shell: "codex.exe", args: ["resume", "thread"] });
  });
});
