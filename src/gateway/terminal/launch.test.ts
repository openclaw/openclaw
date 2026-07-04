import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTerminalEnv, resolveTerminalLaunch, resolveTerminalShell } from "./launch.js";

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
    const workspace = mkdtempSync(path.join(os.tmpdir(), "term-ws-"));
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
    const workspace = mkdtempSync(path.join(os.tmpdir(), "term-ws-nm-"));
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
    const workspace = mkdtempSync(path.join(os.tmpdir(), "term-ws-id-"));
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
