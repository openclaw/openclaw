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

describe("createTerminalLaunchPolicy", () => {
  it("is enabled by default and fails closed when disabled, sandboxed, or unknown-agent", () => {
    expect(createTerminalLaunchPolicy({}).isEnabled()).toBe(true);
    expect(createTerminalLaunchPolicy(disabled).resolve()).toEqual({
      ok: false,
      block: { kind: "disabled" },
    });

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
    const initial: OpenClawConfig = { gateway: { port: 18789, terminal: { enabled: true } } };
    const policy = createTerminalLaunchPolicy(initial);

    policy.prepareConfig({ gateway: { port: 18790, terminal: { enabled: false } } }, restart);
    policy.prepareConfig(initial, restart);
    expectDisabled(policy);

    policy.prepareConfig(
      { gateway: { port: 18790, terminal: { enabled: true, shell: "/bin/new-shell" } } },
      hot,
    );
    policy.commitConfig();
    policy.acceptConfig(acceptHot);
    expectDisabled(policy);

    const disabledPolicy = createTerminalLaunchPolicy(disabled);
    disabledPolicy.prepareConfig(initial, restart);
    expectDisabled(disabledPolicy);
  });

  it("preserves sandbox revocations across later restart-bound updates", () => {
    const workspace = tempDirs.make("term-policy-agent-");
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { workspace }, entries: { ops: {} } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(
      {
        ...baseConfig,
        agents: {
          defaults: { workspace },
          entries: { ops: { sandbox: { mode: "all" } } },
        },
      },
      { restartPending: true },
    );
    policy.prepareConfig(baseConfig, { restartPending: true });

    const resolved = policy.resolve("ops");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.block.kind).toBe("sandboxed");
    }
  });

  it("keeps restart and commit restrictions isolated across agents", () => {
    const baseConfig: OpenClawConfig = fleetConfig();
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(fleetConfig("alpha"), restart);
    policy.prepareConfig(fleetConfig("beta"), hot);

    expect(policy.resolve("alpha").ok).toBe(false);
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

  it("keeps current launch details until a restart-bound change takes effect", () => {
    const workspace = tempDirs.make("term-policy-");
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true, shell: "/bin/old-shell" } },
      agents: { defaults: { workspace } },
    });

    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
        agents: { defaults: { workspace } },
      },
      { restartPending: true },
    );

    const resolved = policy.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.plan.shell).toBe("/bin/old-shell");
    }

    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
        agents: { defaults: { workspace, sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    const tightened = policy.resolve();
    expect(tightened.ok).toBe(false);
    if (!tightened.ok) {
      expect(tightened.block.kind).toBe("sandboxed");
    }
  });

  it.each([false, true])(
    "publishes shell changes only at hot commit with pending restart=%s",
    (restartPending) => {
      const initial: OpenClawConfig = {
        gateway: { terminal: { enabled: true, shell: "/bin/old-shell" } },
      };
      const policy = createTerminalLaunchPolicy(initial);
      const originalLaunch = policy.resolve();
      if (restartPending) {
        policy.prepareConfig({ ...initial, gateway: { ...initial.gateway, port: 18790 } }, restart);
      }
      const nextConfig: OpenClawConfig = {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
      };
      policy.prepareConfig(nextConfig, hot);
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/old-shell" } });

      policy.commitConfig();
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/new-shell" } });
      expect(originalLaunch).toMatchObject({ ok: true, plan: { shell: "/bin/old-shell" } });

      policy.prepareConfig({ gateway: { terminal: { shell: "/bin/rejected-shell" } } }, hot);
      policy.acceptConfig(acceptHot);
      policy.commitConfig();
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/new-shell" } });

      const defaults = createTerminalLaunchPolicy({}).resolve();
      policy.prepareConfig({}, hot);
      policy.commitConfig();
      expect(policy.resolve()).toEqual(defaults);
    },
  );

  it("applies non-restart sandbox policy changes immediately", () => {
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
    });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );

    const blocked = policy.resolve();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.block.kind).toBe("sandboxed");
    }
  });

  it("does not grant a non-restart policy relaxation before commit", () => {
    const policy = createTerminalLaunchPolicy(sandboxConfig("all"));
    policy.prepareConfig(sandboxConfig("off"), hot);
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retains failed hot-reload revocations until a later commit succeeds", () => {
    const baseConfig: OpenClawConfig = sandboxConfig("off");
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(sandboxConfig("all"), hot);
    // Simulate a failed hot reload, followed by a relaxation that has not
    // succeeded yet. The first attempt's revocation must remain in force.
    policy.prepareConfig(baseConfig, hot);
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const restartPolicy = createTerminalLaunchPolicy(baseConfig);
    restartPolicy.prepareConfig(sandboxConfig("all"), hot);
    restartPolicy.prepareConfig(baseConfig, restart);
    expect(restartPolicy.resolve().ok).toBe(false);
    restartPolicy.acceptConfig(acceptHot);
    restartPolicy.commitConfig();
    expect(restartPolicy.resolve().ok).toBe(true);
  });

  it("releases a rejected restart restriction after an accepted revert", () => {
    const baseConfig = enabled;
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(disabled, restart);
    policy.prepareConfig(sandboxConfig("all"), hot);
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);

    policy.acceptConfig(retireRestart);
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(true);
  });

  it("commits a newer hot candidate after a rejected restart is retired", () => {
    const baseConfig: OpenClawConfig = sandboxConfig("all");
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(disabled, restart);
    policy.prepareConfig(sandboxConfig("off"), hot);
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig(retireRestart);
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retires failed hot candidates without clearing committed restart restrictions", () => {
    const baseConfig: OpenClawConfig = sandboxConfig("off");
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(sandboxConfig("all"), hot);
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig(acceptHot);
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const skippedPolicy = createTerminalLaunchPolicy(sandboxConfig("all"));
    skippedPolicy.prepareConfig(baseConfig, hot);
    skippedPolicy.acceptConfig(acceptHot);
    skippedPolicy.commitConfig();
    expect(skippedPolicy.resolve().ok).toBe(false);

    const pendingPolicy = createTerminalLaunchPolicy(baseConfig);
    pendingPolicy.prepareConfig(baseConfig, restart);
    pendingPolicy.prepareConfig(sandboxConfig("all"), hot);
    expect(pendingPolicy.resolve().ok).toBe(false);
    pendingPolicy.acceptConfig(acceptHot);
    pendingPolicy.commitConfig();
    expect(pendingPolicy.resolve().ok).toBe(true);

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

    policy.prepareConfig(disabled, restart);
    policy.acceptConfig(acceptHot);
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);
  });

  it.each([false, true])(
    "commits hot enablement and keeps failed disable restrictions until commit with pending restart=%s",
    (restartPending) => {
      const policy = createTerminalLaunchPolicy(disabled);
      const disabledConfig: OpenClawConfig = {
        gateway: { ...(restartPending ? { port: 18790 } : {}), terminal: { enabled: false } },
      };
      const enabledConfig: OpenClawConfig = {
        gateway: { ...disabledConfig.gateway, terminal: { enabled: true, shell: "/bin/sh" } },
      };
      if (restartPending) {
        policy.prepareConfig(disabledConfig, restart);
        policy.acceptConfig(acceptHot);
      }
      policy.prepareConfig(enabledConfig, hot);
      expectDisabled(policy);

      policy.commitConfig();
      policy.acceptConfig(acceptHot);
      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/sh" } });

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
  it("carries the base env, defaults TERM, and marks the terminal", () => {
    expect(buildTerminalEnv({ PATH: "/usr/bin", FOO: "bar" })).toMatchObject({
      PATH: "/usr/bin",
      FOO: "bar",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OPENCLAW_TERMINAL: "1",
    });
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

  it("preserves color controls without mutating the base env", () => {
    const baseEnv = { FORCE_COLOR: "0", NO_COLOR: "1", COLORTERM: undefined };
    expect(buildTerminalEnv(baseEnv)).toMatchObject({
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      COLORTERM: "truecolor",
    });
    expect(baseEnv).toEqual({ FORCE_COLOR: "0", NO_COLOR: "1", COLORTERM: undefined });
  });

  it("preserves an existing TERM", () => {
    const env = buildTerminalEnv({ TERM: "screen-256color" });
    expect(env.TERM).toBe("screen-256color");
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
