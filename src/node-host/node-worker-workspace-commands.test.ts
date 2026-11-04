import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runWorkspaceCommand } from "./node-worker-workspace-commands.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects successful capped Git indexes, including a cut at a complete NUL record", async () => {
  const root = tempDirs.make("workspace-command-");
  const command = (args: string[], maxOutputBytes?: number) => ({
    workspaceDir: root,
    homeDir: root,
    argv: ["git", "-C", root, ...args],
    maxOutputBytes,
  });
  const git = (args: string[], maxOutputBytes?: number) =>
    runWorkspaceCommand(command(args, maxOutputBytes));
  await git(["init", "--quiet"]);
  await fs.writeFile(path.join(root, "a.bin"), Buffer.from([0, 1, 2, 0, 10]));
  await fs.writeFile(path.join(root, "z-é.txt"), "second");
  await git(["add", "."]);
  expect(await git(["show", ":a.bin"])).toBe("\0\x01\x02\0\n");
  const args = ["ls-files", "--stage", "-z"];
  const full = await git(args);
  expect(full.split("\0").map((record) => record.split("\t")[1])).toEqual([
    "a.bin",
    "z-é.txt",
    undefined,
  ]);
  const bytes = Buffer.byteLength(full);
  await expect(git(args, bytes)).resolves.toBe(full);
  for (const cap of [8, Buffer.byteLength(full.slice(full.indexOf("\0") + 1))]) {
    const actual = await runCommandWithTimeout(command(args).argv, {
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: cap,
    });
    expect(actual).toMatchObject({
      code: 0,
      termination: "exit",
      stdoutTruncatedBytes: bytes - cap,
    });
    expect(Buffer.byteLength(actual.stdout)).toBe(cap);
    expect(actual.stdout).toBe(Buffer.from(full).subarray(-cap).toString());
    await expect(git(args, cap)).rejects.toThrow("command output was truncated");
  }
});
