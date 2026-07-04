import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectUnsafeExecControlShellCommand,
  detectUnsafeExecBroadSearchShellCommand,
  rejectUnsafeExecBroadSearchShellCommand,
} from "./exec-control-command-guard.js";

describe("exec broad search command guard", () => {
  const homeDir = os.homedir();

  it("blocks rg without a narrowed path from the home directory", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("allows rg when the search is narrowed below a protected repo parent", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout openclaw/src",
        workdir: path.join(homeDir, "repos"),
      }),
    ).resolves.toBeNull();
  });

  it("blocks recursive grep over Codex session archives", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep -R timeout ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("blocks protected-root searches hidden behind shell wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'bash -lc "rg timeout ~/.codex"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex"),
    });
  });

  it("keeps wrapper-payload cd changes scoped to the child shell", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash -lc 'cd /tmp'; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash -lc 'cd ~; rg timeout'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("blocks find over external workspace roots", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find /Volumes/LEXAR/Codex -name '*.jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      protectedRoot: "/Volumes/LEXAR/Codex",
    });
  });

  it("blocks find over protected roots after leading find options", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find -L ~/.codex/sessions -name '*.jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("blocks find over protected roots after BSD leading find options", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find -E ~/.codex/sessions -regex '.*jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find -f ~/.codex/sessions -name '*.jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("skips find option terminators before path operands", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find -- ~/.codex/sessions -name '*.jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("uses pre-assignment shell env for same-command path expansion", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "HOME=/tmp rg timeout ~/.codex",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex"),
    });
  });

  it("allows find when narrowed to a repo subtree", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find src -name '*.ts'",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toBeNull();
  });

  it("does not block non-recursive grep", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep timeout ~/.codex/sessions/log.txt",
        workdir: "/tmp",
      }),
    ).resolves.toBeNull();
  });

  it("blocks recursive grep with filter option operands and implicit cwd search", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep -R --include '*.ts' timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("expands shell HOME variables before checking protected roots", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'rg timeout "$HOME"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep -R timeout ${HOME}/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("expands shell tilde against OS home instead of OPENCLAW_HOME", async () => {
    const originalHome = process.env.HOME;
    const originalOpenClawHome = process.env.OPENCLAW_HOME;
    const shellHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-home-"));
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-home-"));
    try {
      process.env.HOME = shellHome;
      process.env.OPENCLAW_HOME = openclawHome;
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "rg timeout ~",
          workdir: "/tmp",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        protectedRoot: path.resolve(shellHome),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalOpenClawHome;
      }
      fs.rmSync(shellHome, { recursive: true, force: true });
      fs.rmSync(openclawHome, { recursive: true, force: true });
    }
  });

  it("treats grep directories recurse as recursive", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep -d recurse timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep --directories=recurse timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("treats grep dereference-recursive as recursive", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep --dereference-recursive timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("blocks searches over workspace-style repo parents", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ..",
        workdir: "/workspace/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: "..",
      protectedRoot: "/workspace",
    });
  });

  it("blocks searches over GitHub runner-style repo parents", async () => {
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = "/home/runner";
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "rg timeout ..",
          workdir: "/home/runner/work/openclaw/openclaw",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: "..",
        protectedRoot: "/home/runner/work/openclaw",
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("does not consume rg boolean flags as option operands", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --mmap timeout ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("does not consume rg glob-case-insensitive as an option operand", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --glob-case-insensitive timeout ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("honors shell cd before resolving implicit search paths", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd ~ && rg timeout",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("does not apply cd from an unexecuted control-flow branch", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "if false; then cd /tmp; fi; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("fails closed after cwd changes inside shell control flow", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "if true; then cd ~; fi; rg timeout",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("does not apply cd from short-circuit shell branches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "false && cd /tmp; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "true || cd /tmp; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves source offsets when tracking short-circuit cwd changes", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "  false && cd /tmp; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("fails closed after cwd changes in short-circuit chains", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'true && cd "$HOME" && rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("does not apply cd from pipeline subshells", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd /tmp | cat; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("does not apply cd from background jobs", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd /tmp & rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("tracks pushd before pathless searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'pushd "$HOME" >/dev/null; rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("tracks cwd changes through command and builtin cd wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "command cd; rg timeout",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "builtin cd; rg timeout",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves cwd when a failed cd would leave the shell in place", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd /definitely-missing-openclaw-search-guard; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("fails closed on unresolved shell-expanded cd targets", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd ~root; rg timeout",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves cwd when cd has too many operands to succeed", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd /tmp /; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("resolves cd dash against OLDPWD", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd - >/dev/null; rg timeout",
        workdir: "/tmp",
        env: { ...process.env, OLDPWD: homeDir },
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves cwd when cd has invalid options", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "cd -x /tmp; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("updates PWD and OLDPWD when tracking cd targets", async () => {
    const sessionDir = path.join(homeDir, ".codex", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: 'cd "$HOME"; rg timeout "$PWD/.codex/sessions"',
          workdir: "/tmp",
          env: { ...process.env, HOME: homeDir, PWD: "/tmp" },
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        protectedRoot: sessionDir,
      });
    } finally {
      fs.rmSync(path.join(homeDir, ".codex"), { recursive: true, force: true });
    }
  });

  it("treats loop bodies as conditional cwd changes", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "while false; do cd /tmp; done; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("does not leak subshell cd into later outer commands", async () => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-search-guard-home-"));
    try {
      fs.mkdirSync(path.join(tempHome, ".codex", "sessions"), { recursive: true });
      process.env.HOME = tempHome;
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "(cd ~/.codex/sessions); rg timeout",
          workdir: "/Volumes/LEXAR/repos/openclaw",
        }),
      ).resolves.toBeNull();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps subshell cd scoped to commands inside the same subshell", async () => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-search-guard-home-"));
    try {
      fs.mkdirSync(path.join(tempHome, ".codex", "sessions"), { recursive: true });
      process.env.HOME = tempHome;
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "(cd ~/.codex/sessions; rg timeout)",
          workdir: "/Volumes/LEXAR/repos/openclaw",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: ".",
        protectedRoot: path.join(tempHome, ".codex", "sessions"),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("inherits cwd when entering subshells", async () => {
    const safeRepoDir = path.join(process.cwd(), "src");
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: `cd ${safeRepoDir}; (rg timeout)`,
        workdir: homeDir,
      }),
    ).resolves.toBeNull();
  });

  it("treats pattern files as supplying the search pattern", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg -f patterns ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "grep -R -f patterns ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "grep",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("skips rg value operands before inferring implicit cwd searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --ignore-file .ignore timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg -E utf-8 timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg -j 4 timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("skips additional rg value operands before inferring implicit cwd searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg -M 100 timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --color always timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --type-not rust timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("accounts for shell-expanded glob search paths", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout *",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: "*",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ~/.codex/sessions/*",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("accounts for brace-expanded protected paths", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ~/.{codex,openclaw}",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: homeDir,
    });
  });

  it("preserves quoted path arguments with spaces", async () => {
    const originalHome = process.env.HOME;
    const spacedHome = path.join(os.tmpdir(), "Jane Doe");
    try {
      process.env.HOME = spacedHome;
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: 'rg timeout "$HOME"',
          workdir: "/tmp",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        protectedRoot: path.resolve(spacedHome),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("resolves symlinked protected roots before classifying searches", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-search-guard-"));
    const linkPath = path.join(tempDir, "home-link");
    try {
      fs.symlinkSync(homeDir, linkPath, "dir");
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "rg timeout",
          workdir: linkPath,
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: ".",
        protectedRoot: homeDir,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores heredoc bodies when the shell command parses successfully", async () => {
    await expect(
      detectUnsafeExecControlShellCommand("cat >note <<'EOF'\n/approve abc deny\nEOF"),
    ).resolves.toBeNull();
  });

  it("blocks broad searches through transparent dispatch wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "timeout 5 rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "time rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves env --chdir cwd when unwrapping command carriers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'env -C "$HOME" rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("skips env option operands before honoring later chdir", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'env -u FOO -C "$HOME" rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("preserves sudo --chdir cwd when unwrapping command carriers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'sudo -D "$HOME" rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("resolves command carriers after transparent dispatch wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "timeout 5 env -i rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("inspects static xargs command payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "xargs rg timeout ~/.codex/sessions < /dev/null",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("fails closed when xargs can append unknown search paths", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "printf '%s\\n' \"$HOME/.codex/sessions\" | xargs rg timeout",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: "<dynamic xargs-appended search path>",
      protectedRoot: "<dynamic xargs-appended search path>",
    });
  });

  it("re-expands shell wrappers inside static xargs command payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "xargs sh -c 'rg timeout ~/.codex/sessions' < /dev/null",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("inspects static find exec command payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find . -maxdepth 0 -exec rg timeout ~/.codex/sessions \\;",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("re-expands shell wrappers inside static find exec payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find . -maxdepth 0 -exec sh -c 'rg timeout ~/.codex/sessions' \\;",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("fails closed for find roots loaded from files0-from", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "find -files0-from list -name '*.jsonl'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "find",
      path: "<dynamic find -files0-from roots>",
      protectedRoot: "<dynamic find -files0-from roots>",
    });
  });

  it("blocks broad searches behind non-transparent dispatch wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "setsid rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "ionice rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "taskset 0x1 rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("resolves shell positional dispatch wrappers", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash -lc 'exec \"$@\"' sh rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("substitutes shell positional args into wrapper payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash -lc 'rg timeout \"$@\"' sh ~/.codex/sessions",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("blocks descendants of protected state roots", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ~/.codex/sessions/2026",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ~/.openclaw/logs",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".openclaw"),
    });
  });

  it("protects configured OpenClaw state roots", async () => {
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-root-"));
    try {
      fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "rg timeout $OPENCLAW_STATE_DIR/sessions",
          workdir: "/tmp",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        protectedRoot: stateDir,
      });
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: `find ${stateDir} -name '*.jsonl'`,
          workdir: "/tmp",
        }),
      ).resolves.toMatchObject({
        executable: "find",
        protectedRoot: stateDir,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("expands OpenClaw state variables from the effective exec environment", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-env-root-"));
    try {
      fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: 'rg timeout "$OPENCLAW_STATE_DIR/sessions"',
          workdir: "/tmp",
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        protectedRoot: stateDir,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("expands arbitrary variables from the effective exec environment", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'rg timeout "$SESSION_ROOT"',
        workdir: "/tmp",
        env: { ...process.env, SESSION_ROOT: path.join(homeDir, ".codex", "sessions") },
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("tracks shell-local variables before path expansion", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'SESSION_ROOT=$HOME/.codex/sessions; rg timeout "$SESSION_ROOT"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("keeps payloads distinct when shell env changes", async () => {
    const result = await detectUnsafeExecBroadSearchShellCommand({
      command:
        'SESSION_ROOT=/var/tmp/openclaw-safe-search; rg token "$SESSION_ROOT"; SESSION_ROOT=$HOME/.codex/sessions; rg token "$SESSION_ROOT"',
      workdir: "/tmp",
    });
    expect(result).toMatchObject({
      executable: "rg",
      path: "$SESSION_ROOT",
    });
    expect(result?.protectedRoot).not.toBe("/var/tmp/openclaw-safe-search");
  });

  it("ignores unexecuted shell assignments when expanding later paths", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command:
          'SESSION_ROOT=$HOME/.codex/sessions; if false; then SESSION_ROOT=/tmp; fi; rg timeout "$SESSION_ROOT"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("expands shell variables outside the first path segment", async () => {
    const user = path.basename(homeDir);
    const homeParent = path.dirname(homeDir);
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: `rg timeout ${homeParent}/$USER/.codex/sessions`,
        workdir: "/tmp",
        env: { ...process.env, USER: user },
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("treats parents of configured state roots as protected", async () => {
    const stateParent = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-parent-"));
    const stateDir = path.join(stateParent, "state");
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: `rg timeout ${stateParent}`,
          workdir: "/tmp",
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: stateParent,
        protectedRoot: path.resolve(stateParent),
      });
    } finally {
      fs.rmSync(stateParent, { recursive: true, force: true });
    }
  });

  it("blocks explicit parent paths that contain the protected home", async () => {
    const homeParent = path.dirname(homeDir);
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: `rg timeout ${homeParent}`,
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: homeParent,
      protectedRoot: path.resolve(homeParent),
    });
  });

  it("protects current repo parents regardless of parent folder name", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-src-parent-"));
    const workdir = path.join(parent, "openclaw");
    try {
      fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "rg timeout ..",
          workdir,
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: "..",
        protectedRoot: parent,
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("protects caller-supplied sandbox workspace roots", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout",
        workdir: "/remote/workspace",
        additionalProtectedRoots: ["/remote/workspace"],
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: "/remote/workspace",
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ..",
        workdir: "/remote/workspace/openclaw",
        additionalProtectedRoots: ["/remote/workspace"],
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: "..",
      protectedRoot: "/remote/workspace",
    });
  });

  it("allows narrowed repo searches below caller-supplied sandbox workspace roots", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout",
        workdir: "/remote/workspace/openclaw",
        additionalProtectedRoots: ["/remote/workspace"],
      }),
    ).resolves.toBeNull();
  });

  it("does not treat pattern operands named help as help invocations", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg -e --help ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg --help ~/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toBeNull();
  });

  it("does not treat piped rg filters as filesystem searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "printf 'x\\n' | rg x",
        workdir: homeDir,
      }),
    ).resolves.toBeNull();
  });

  it("does not treat piped rg regexp filters as filesystem searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "printf 'x\\n' | rg -e x",
        workdir: homeDir,
      }),
    ).resolves.toBeNull();
  });

  it("does not treat redirected rg filters as filesystem searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg x < /tmp/log",
        workdir: homeDir,
      }),
    ).resolves.toBeNull();
  });

  it("inspects static eval bodies before classifying searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "eval 'rg timeout ~/.codex/sessions'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("tracks cwd changes inside static eval bodies", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "eval 'cd \"$HOME\"; rg timeout'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("tracks cwd changes across control operators inside static shell payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "eval 'cd \"$HOME\" && rg timeout'",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("keeps conditional cwd changes conditional inside static shell payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "eval 'false && cd /tmp; rg timeout'",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("ignores uninvoked shell function definition bodies", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "f(){ rg timeout ~/.codex/sessions; }; echo ok",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toBeNull();
  });

  it("tracks cwd changes performed by shell functions", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'f(){ cd "$HOME"; }; f; rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("tracks function cd targets supplied as arguments", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'f(){ cd "$1"; }; f "$HOME"; rg timeout',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("keeps function cwd changes conditional like their invocation", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "f(){ cd /tmp; }; false && f; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("handles bare cd inside shell functions", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "f(){ cd; }; f; rg timeout",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("inspects searches inside invoked shell function bodies", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "f(){ rg timeout ~/.codex/sessions; }; f",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("inspects shell scripts supplied through heredocs", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash <<'EOF'\nrg timeout ~/.codex/sessions\nEOF",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("tracks cwd changes inside heredoc shell scripts", async () => {
    const sessionDir = path.join(homeDir, ".codex", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "bash <<'EOF'\ncd ~/.codex/sessions\nrg timeout\nEOF",
          workdir: "/Volumes/LEXAR/repos/openclaw",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: ".",
        protectedRoot: sessionDir,
      });
    } finally {
      fs.rmSync(path.join(homeDir, ".codex"), { recursive: true, force: true });
    }
  });

  it("inspects here-string shell stdin payloads", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "bash <<< 'rg timeout ~/.codex/sessions'",
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
  });

  it("tracks cwd inside command substitutions", async () => {
    const sessionDir = path.join(homeDir, ".codex", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: 'echo "$(cd ~/.codex/sessions; rg timeout)"',
          workdir: "/Volumes/LEXAR/repos/openclaw",
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: ".",
        protectedRoot: sessionDir,
      });
    } finally {
      fs.rmSync(path.join(homeDir, ".codex"), { recursive: true, force: true });
    }
  });

  it("fails closed on command-substituted search operands", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'rg timeout "$(printf %s "$HOME/.codex/sessions")"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: "<dynamic shell-expanded search path>",
    });
  });

  it("fails closed on unresolved simple variable search operands", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'for d in "$HOME/.codex/sessions"; do rg timeout "$d"; done',
        workdir: "/Volumes/LEXAR/repos/openclaw",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: "<dynamic shell-expanded search path>",
    });
  });

  it("fails closed on complex parameter-expanded search operands", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: 'rg timeout "${SESSION_ROOT:-$HOME/.codex/sessions}"',
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: "<dynamic shell-expanded search path>",
    });
  });

  it("honors CDPATH when tracking cd targets", async () => {
    const cdpathRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cdpath-"));
    const cdpathHome = path.join(cdpathRoot, "alice");
    try {
      fs.mkdirSync(cdpathHome, { recursive: true });
      await expect(
        detectUnsafeExecBroadSearchShellCommand({
          command: "CDPATH=$HOME/..; cd alice; rg timeout",
          workdir: "/tmp",
          env: { ...process.env, HOME: cdpathHome },
        }),
      ).resolves.toMatchObject({
        executable: "rg",
        path: ".",
        protectedRoot: cdpathHome,
      });
    } finally {
      fs.rmSync(cdpathRoot, { recursive: true, force: true });
    }
  });

  it("preserves cwd when CDPATH targets do not exist", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "CDPATH=/tmp; cd definitely-missing-openclaw-search-guard; rg timeout",
        workdir: homeDir,
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      path: ".",
      protectedRoot: homeDir,
    });
  });

  it("expands tilde-user prefixes before protection checks", async () => {
    const username = os.userInfo().username;
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: `rg timeout ~${username}/.codex/sessions`,
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: path.join(homeDir, ".codex", "sessions"),
    });
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout ~root/.codex/sessions",
        workdir: "/tmp",
      }),
    ).resolves.toMatchObject({
      executable: "rg",
      protectedRoot: "<dynamic shell-expanded search path>",
    });
  });

  it("rejects broad searches with actionable guidance", async () => {
    await expect(
      rejectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout",
        workdir: homeDir,
      }),
    ).rejects.toThrow(/Narrow the command to a repo, task, exact file, or evidence directory/u);
  });
});
