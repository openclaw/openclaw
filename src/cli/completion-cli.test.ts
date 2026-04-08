import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { getCompletionScript, getShellProfilePath } from "./completion-cli.js";

function createCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.description("CLI root");
  program.option("-v, --verbose", "Verbose output");

  const gateway = program.command("gateway").description("Gateway commands");
  gateway.option("--force", "Force the action");

  gateway.command("status").description("Show gateway status").option("--json", "JSON output");
  gateway.command("restart").description("Restart gateway");

  return program;
}

describe("completion-cli", () => {
  it("generates zsh functions for nested subcommands", () => {
    const script = getCompletionScript("zsh", createCompletionProgram());

    expect(script).toContain("_openclaw_gateway()");
    expect(script).toContain("(status) _openclaw_gateway_status ;;");
    expect(script).toContain("(restart) _openclaw_gateway_restart ;;");
    expect(script).toContain("--force[Force the action]");
  });

  it("defers zsh registration until compinit is available", async () => {
    if (process.platform === "win32") {
      return;
    }

    const probe = spawnSync("zsh", ["-fc", "exit 0"], { encoding: "utf8" });
    if (probe.error) {
      if (
        "code" in probe.error &&
        (probe.error.code === "ENOENT" || probe.error.code === "EACCES")
      ) {
        return;
      }
      throw probe.error;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zsh-completion-"));
    try {
      const scriptPath = path.join(tempDir, "openclaw.zsh");
      await fs.writeFile(scriptPath, getCompletionScript("zsh", createCompletionProgram()), "utf8");

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `
            source ${JSON.stringify(scriptPath)}
            [[ -z "\${_comps[openclaw]-}" ]] || exit 10
            [[ "\${precmd_functions[(r)_openclaw_register_completion]}" = "_openclaw_register_completion" ]] || exit 11
            autoload -Uz compinit
            compinit -C
            _openclaw_register_completion
            [[ -z "\${precmd_functions[(r)_openclaw_register_completion]}" ]] || exit 12
            [[ "\${_comps[openclaw]-}" = "_openclaw_root_completion" ]]
          `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tempDir,
            ZDOTDIR: tempDir,
          },
        },
      );

      expect(result.stderr).not.toContain("command not found: compdef");
      expect(result.status).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("generates PowerShell command paths without the executable prefix", () => {
    const script = getCompletionScript("powershell", createCompletionProgram());

    expect(script).toContain("if ($commandPath -eq 'gateway') {");
    expect(script).toContain("if ($commandPath -eq 'gateway status') {");
    expect(script).not.toContain("if ($commandPath -eq 'openclaw gateway') {");
    expect(script).toContain("$completions = @('status','restart','--force')");
  });

  it("generates fish completions for root and nested command contexts", () => {
    const script = getCompletionScript("fish", createCompletionProgram());

    expect(script).toContain(
      'complete -c openclaw -n "__fish_use_subcommand" -a "gateway" -d \'Gateway commands\'',
    );
    expect(script).toContain(
      'complete -c openclaw -n "__fish_seen_subcommand_from gateway" -a "status" -d \'Show gateway status\'',
    );
    expect(script).toContain(
      "complete -c openclaw -n \"__fish_seen_subcommand_from gateway\" -l force -d 'Force the action'",
    );
  });
});

describe("getShellProfilePath", () => {
  it("zsh: uses ZDOTDIR when set", () => {
    const result = getShellProfilePath("zsh", {
      HOME: "/home/user",
      ZDOTDIR: "/home/user/.config/zsh",
    });
    expect(result).toBe(path.join("/home/user/.config/zsh", ".zshrc"));
  });

  it("zsh: falls back to HOME when ZDOTDIR is not set", () => {
    const result = getShellProfilePath("zsh", { HOME: "/home/user" });
    expect(result).toBe(path.join("/home/user", ".zshrc"));
  });

  it("fish: uses XDG_CONFIG_HOME when set", () => {
    const result = getShellProfilePath("fish", {
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/custom/config",
    });
    expect(result).toBe(path.join("/custom/config", "fish", "config.fish"));
  });

  it("fish: falls back to ~/.config when XDG_CONFIG_HOME is not set", () => {
    const result = getShellProfilePath("fish", { HOME: "/home/user" });
    expect(result).toBe(path.join("/home/user/.config", "fish", "config.fish"));
  });

  it("bash: defaults to .bashrc", async () => {
    // Create a temp dir with a .bashrc file to ensure the existsSync check works
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bash-profile-"));
    try {
      await fs.writeFile(path.join(tempDir, ".bashrc"), "", "utf-8");
      const result = getShellProfilePath("bash", { HOME: tempDir });
      expect(result).toBe(path.join(tempDir, ".bashrc"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bash: falls back to .bash_profile when .bashrc does not exist", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bash-profile-"));
    try {
      // Only create .bash_profile, not .bashrc
      await fs.writeFile(path.join(tempDir, ".bash_profile"), "", "utf-8");
      const result = getShellProfilePath("bash", { HOME: tempDir });
      expect(result).toBe(path.join(tempDir, ".bash_profile"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bash: defaults to .bash_profile when neither file exists", async () => {
    // macOS Terminal opens login shells that only source .bash_profile,
    // so creating .bashrc for a fresh user would silently break completion.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bash-profile-"));
    try {
      const result = getShellProfilePath("bash", { HOME: tempDir });
      expect(result).toBe(path.join(tempDir, ".bash_profile"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("powershell: uses XDG_CONFIG_HOME on non-Windows", () => {
    if (process.platform === "win32") {
      return;
    }
    const result = getShellProfilePath("powershell", {
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/custom/config",
    });
    expect(result).toBe(
      path.join("/custom/config", "powershell", "Microsoft.PowerShell_profile.ps1"),
    );
  });
});
