import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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

  it("rejects broad searches with actionable guidance", async () => {
    await expect(
      rejectUnsafeExecBroadSearchShellCommand({
        command: "rg timeout",
        workdir: homeDir,
      }),
    ).rejects.toThrow(/Narrow the command to a repo, task, exact file, or evidence directory/u);
  });
});
