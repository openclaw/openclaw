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

  it("does not treat piped rg filters as filesystem searches", async () => {
    await expect(
      detectUnsafeExecBroadSearchShellCommand({
        command: "printf 'x\\n' | rg x",
        workdir: homeDir,
      }),
    ).resolves.toBeNull();
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
