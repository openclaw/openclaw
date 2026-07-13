import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildTerminalEnv,
  createTerminalLaunchPolicy,
  resolveTerminalLaunch,
  resolveTerminalShell,
} from "./launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("resolveTerminalShell", () => {
  it("prefers an explicitly configured shell", () => {
    const resolved = resolveTerminalShell({
      configuredShell: "/usr/bin/fish",
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
    });
    expect(resolved).toEqual({ shell: "/usr/bin/fish", args: [] });
  });

  it("uses the unix login shell as a login shell", () => {
    const resolved = resolveTerminalShell({ platform: "linux", env: { SHELL: "/bin/zsh" } });
    expect(resolved).toEqual({ shell: "/bin/zsh", args: ["-l"] });
  });

  it("falls back to bash when no login shell is set", () => {
    const resolved = resolveTerminalShell({ platform: "linux", env: {} });
    expect(resolved).toEqual({ shell: "/bin/bash", args: ["-l"] });
  });

  it("uses ComSpec on windows", () => {
    const resolved = resolveTerminalShell({
      platform: "win32",
      env: { ComSpec: "C:/Windows/System32/cmd.exe" },
    });
    expect(resolved).toEqual({ shell: "C:/Windows/System32/cmd.exe", args: [] });
  });
});

describe("resolveTerminalLaunch", () => {
  it("blocks when the terminal is disabled", () => {
    const result = resolveTerminalLaunch({ config: {} as OpenClawConfig, enabled: false });
    expect(result).toEqual({ ok: false, block: { kind: "disabled" } });
  });

  it("returns a host plan starting in the agent workspace", () => {
    const workspace = tempDirs.make("term-ws-");
    const config = {
      agents: { defaults: { workspace } },
    } as unknown as OpenClawConfig;
    const result = resolveTerminalLaunch({
      config,
      enabled: true,
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.cwd).toBe(workspace);
      expect(result.plan.shell).toBe("/bin/zsh");
      expect(result.plan.args).toEqual(["-l"]);
      expect(result.plan.agentId).toBeTruthy();
    }
  });

  it("fails closed for a fully sandboxed (mode: all) agent", () => {
    const config = {
      agents: { defaults: { sandbox: { mode: "all" } } },
    } as unknown as OpenClawConfig;
    const result = resolveTerminalLaunch({ config, enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.block.kind).toBe("sandboxed");
      if (result.block.kind === "sandboxed") {
        expect(result.block.mode).toBe("all");
      }
    }
  });

  it("allows a host terminal under non-main sandbox mode (main session runs on host)", () => {
    const workspace = tempDirs.make("term-ws-nm-");
    const config = {
      agents: { defaults: { workspace, sandbox: { mode: "non-main" } } },
    } as unknown as OpenClawConfig;
    const result = resolveTerminalLaunch({
      config,
      enabled: true,
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.cwd).toBe(workspace);
    }
  });

  it("fails closed for an unknown explicit agent id", () => {
    // Every configured agent is fully sandboxed; an unknown id must not fall
    // through to the (unsandboxed) global defaults and a host-home shell.
    const config = {
      agents: {
        list: [{ id: "locked", sandbox: { mode: "all" } }],
      },
    } as unknown as OpenClawConfig;
    const result = resolveTerminalLaunch({
      config,
      enabled: true,
      agentId: "ghost",
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
    });
    expect(result).toEqual({ ok: false, block: { kind: "unknown-agent", agentId: "ghost" } });
  });

  it("accepts an explicit id that names a configured agent", () => {
    const workspace = tempDirs.make("term-ws-id-");
    const config = {
      agents: {
        defaults: { workspace },
        list: [{ id: "Ops" }],
      },
    } as unknown as OpenClawConfig;
    const result = resolveTerminalLaunch({
      config,
      enabled: true,
      agentId: "ops",
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.agentId).toBe("ops");
    }
  });
});

describe("createTerminalLaunchPolicy", () => {
  it("applies restart-bound revocations without granting access early", () => {
    const enabled = {
      gateway: { terminal: { enabled: true } },
    } as OpenClawConfig;
    const policy = createTerminalLaunchPolicy(enabled);

    policy.prepareConfig({}, { restartPending: true });
    policy.prepareConfig(enabled, { restartPending: true });
    expect(policy.isEnabled()).toBe(false);
    expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    const disabledPolicy = createTerminalLaunchPolicy({});
    disabledPolicy.prepareConfig(enabled, { restartPending: true });
    expect(disabledPolicy.isEnabled()).toBe(false);
    expect(disabledPolicy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
  });

  it("preserves sandbox revocations across later restart-bound updates", () => {
    const workspace = tempDirs.make("term-policy-agent-");
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { workspace }, list: [{ id: "ops" }] },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(
      {
        ...baseConfig,
        agents: {
          defaults: { workspace },
          list: [{ id: "ops", sandbox: { mode: "all" } }],
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
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" } } },
      },
      { restartPending: false },
    );
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retains failed hot-reload revocations until a later commit succeeds", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    // Simulate a failed hot reload, followed by a relaxation that has not
    // succeeded yet. The first attempt's revocation must remain in force.
    policy.prepareConfig(baseConfig, { restartPending: false });
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const restartPolicy = createTerminalLaunchPolicy(baseConfig);
    restartPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    restartPolicy.prepareConfig(baseConfig, { restartPending: true });
    expect(restartPolicy.resolve().ok).toBe(false);
    restartPolicy.acceptConfig({ retireRejectedRestart: false });
    restartPolicy.commitConfig();
    expect(restartPolicy.resolve().ok).toBe(true);
  });

  it("releases a rejected restart restriction after an accepted revert", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig({}, { restartPending: true });
    policy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: true });
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(true);
  });

  it("commits a newer hot candidate after a rejected restart is retired", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig({}, { restartPending: true });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" } } },
      },
      { restartPending: false },
    );
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: true });
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retires failed hot candidates without clearing committed restart restrictions", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: false });
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const skippedPolicy = createTerminalLaunchPolicy({
      ...baseConfig,
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    skippedPolicy.prepareConfig(baseConfig, { restartPending: false });
    skippedPolicy.acceptConfig({ retireRejectedRestart: false });
    skippedPolicy.commitConfig();
    expect(skippedPolicy.resolve().ok).toBe(false);

    const pendingPolicy = createTerminalLaunchPolicy(baseConfig);
    pendingPolicy.prepareConfig(baseConfig, { restartPending: true });
    pendingPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    expect(pendingPolicy.resolve().ok).toBe(false);
    pendingPolicy.acceptConfig({ retireRejectedRestart: false });
    pendingPolicy.commitConfig();
    expect(pendingPolicy.resolve().ok).toBe(true);

    const appliedPendingPolicy = createTerminalLaunchPolicy(baseConfig);
    appliedPendingPolicy.prepareConfig(baseConfig, { restartPending: true });
    appliedPendingPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig({ retireRejectedRestart: false });
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(false);
    appliedPendingPolicy.prepareConfig(baseConfig, { restartPending: false });
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig({ retireRejectedRestart: false });
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(true);

    policy.prepareConfig({}, { restartPending: true });
    policy.acceptConfig({ retireRejectedRestart: false });
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);
  });

  it("does not promote a terminal setting previously ignored by reload mode", () => {
    const disabledPolicy = createTerminalLaunchPolicy({});
    disabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    disabledPolicy.commitConfig();
    expect(disabledPolicy.isEnabled()).toBe(false);
    expect(disabledPolicy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    const enabledPolicy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true, shell: "/bin/current-shell" } },
    });
    enabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: false, shell: "/bin/ignored-shell" } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    enabledPolicy.commitConfig();
    expect(enabledPolicy.isEnabled()).toBe(true);
    const resolved = enabledPolicy.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.plan.shell).toBe("/bin/current-shell");
    }

    enabledPolicy.prepareConfig({}, { restartPending: true });
    enabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    expect(enabledPolicy.isEnabled()).toBe(false);
  });
});

describe("buildTerminalEnv", () => {
  it("carries the base env, defaults TERM, and marks the terminal", () => {
    const env = buildTerminalEnv({ PATH: "/usr/bin", FOO: "bar" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.OPENCLAW_TERMINAL).toBe("1");
  });

  it("preserves an existing TERM", () => {
    const env = buildTerminalEnv({ TERM: "screen-256color" });
    expect(env.TERM).toBe("screen-256color");
  });
});
