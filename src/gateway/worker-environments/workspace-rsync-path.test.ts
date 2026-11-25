import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { prepareLocalWorkspaceRsyncReceiver } from "./tunnel.test-support.js";
import {
  createWorkerWorkspaceRsyncReceiverPathFactory,
  WORKER_WORKSPACE_RSYNC_DESTINATION as destination,
  workerAcceptedWorkspaceRsyncReceiverPath,
  workerWorkspaceRsyncReceiverEntryPath,
} from "./workspace-sync-helpers.js";
import { writeWorkspaceFiles } from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readArgv = async (file: string) =>
  (await fs.readFile(file, "utf8")).split("\0").filter(Boolean);
const receiverScripts = {
  rsync:
    '#!/bin/sh\nset -eu\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_RECEIVER_ARGV"\nexec "$OPENCLAW_TEST_REAL_RSYNC" "$@"\n',
  ssh: '#!/bin/sh\nset -eu\nshift\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_SSH_ARGV"\ncd "$HOME"\nexec sh -c "$*"\n',
};

it
  .skipIf(process.platform === "win32")
  .each(["workspace-root", "git-pack", "accepted-next"] as const)(
  "crosses the real rsync and OpenSSH argv boundary for %s",
  async (mode) => {
    const directory = mode === "workspace-root";
    const root = path.join(tempDirs.make("openclaw-rsync-path-"), "paths with spaces");
    let home = path.join(root, "remote home");
    let workspace = path.join(home, ".openclaw-worker/workspaces/env/session/1");
    const payload = directory ? "source dir/payload.txt" : "input.bin";
    const source = path.join(root, directory ? path.dirname(payload) : payload);
    const tools = tempDirs.make("openclaw-rsync-tools-");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(tools, { recursive: true });
    [home, workspace] = await Promise.all([fs.realpath(home), fs.realpath(workspace)]);
    const nonce = "b".repeat(32);
    const receiverEntryPath = workerWorkspaceRsyncReceiverEntryPath("a".repeat(64));
    await prepareLocalWorkspaceRsyncReceiver(path.join(home, receiverEntryPath));

    const resolvedRsync = await runCommandWithTimeout(["sh", "-c", "command -v rsync"], {
      timeoutMs: 10_000,
    });
    expect(resolvedRsync).toMatchObject({ termination: "exit", code: 0 });
    const rsync = resolvedRsync.stdout.trim();
    for (const [name, script] of Object.entries(receiverScripts)) {
      await fs.writeFile(path.join(tools, name), script, { mode: 0o755 });
    }
    const fakeSsh = path.join(tools, "ssh");

    const receiver = { receiverEntryPath, remoteWorkspaceDir: workspace };
    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    const transaction = path.join(
      path.dirname(workspace),
      `.openclaw-accepted-${workspaceKey}-${nonce}`,
    );
    const receiverTarget =
      mode === "git-pack"
        ? path.join(workspace, ".openclaw-base.pack")
        : mode === "accepted-next"
          ? path.join(transaction, "next")
          : workspace;
    if (mode === "accepted-next") {
      await fs.mkdir(receiverTarget, { recursive: true });
      await fs.writeFile(
        path.join(transaction, "phase.json"),
        JSON.stringify({ version: 1, nonce, phase: "begun" }),
      );
    }
    const receiverCommand =
      mode === "accepted-next"
        ? workerAcceptedWorkspaceRsyncReceiverPath({ ...receiver, nonce })
        : createWorkerWorkspaceRsyncReceiverPathFactory({
            ...receiver,
            canonicalHome: home,
            remoteRelative: path.posix.relative(home, workspace),
          })(mode);

    const contents = `received through ${mode}\n`;
    await writeWorkspaceFiles(root, { [payload]: contents });
    const baseEnv = {
      ...process.env,
      HOME: home,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      OPENCLAW_TEST_REAL_RSYNC: rsync,
      OPENCLAW_TEST_RECEIVER_ARGV: path.join(root, "receiver-argv"),
      OPENCLAW_TEST_SSH_ARGV: path.join(root, "ssh-argv"),
    };
    const argv = [rsync, "--archive", "--checksum"];
    argv.push(`--rsync-path=${receiverCommand}`, "-e", fakeSsh, "--");
    argv.push(directory ? `${source}/` : source, `test:${destination}`);
    const result = await runCommandWithTimeout(argv, { timeoutMs: 30_000, baseEnv });
    expect(result).toMatchObject({ termination: "exit", code: 0 });
    const receivedPath =
      mode === "git-pack" ? receiverTarget : path.join(receiverTarget, path.basename(payload));
    await expect(fs.readFile(receivedPath, "utf8")).resolves.toBe(contents);

    const sshArgv = await readArgv(baseEnv.OPENCLAW_TEST_SSH_ARGV);
    expect(sshArgv.join(" ")).toMatch(
      /^node [A-Za-z0-9_./-]+ (?:workspace-root|git-pack|accepted-next) [A-Za-z0-9_-]+ [a-f0-9]{32} --server /u,
    );
    expect(sshArgv.at(-1)).toBe(destination);
    expect(sshArgv.join(" ")).not.toContain(workspace);
    const receiverArgv = await readArgv(baseEnv.OPENCLAW_TEST_RECEIVER_ARGV);
    expect(receiverArgv.at(-1)).toBe(receiverTarget);
    await expect(fs.access(path.join(home, destination))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
