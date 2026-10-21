import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { prepareLocalWorkspaceRsyncReceiver } from "./tunnel.test-support.js";
import {
  createWorkerWorkspaceRsyncReceiverPathFactory,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
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
    const homePath = path.join(root, "remote home");
    const workspacePath = path.join(homePath, ".openclaw-worker/workspaces/env/session/1");
    const source = path.join(root, directory ? "source dir" : "input.bin");
    const tools = tempDirs.make("openclaw-rsync-tools-");
    const sshArgvPath = path.join(root, "ssh-argv");
    const receiverArgvPath = path.join(root, "receiver-argv");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(tools, { recursive: true });
    const home = await fs.realpath(homePath);
    const workspace = await fs.realpath(workspacePath);
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
    await writeWorkspaceFiles(root, {
      [directory ? "source dir/payload.txt" : "input.bin"]: contents,
    });
    const result = await runCommandWithTimeout(
      [
        rsync,
        "--archive",
        "--checksum",
        `--rsync-path=${receiverCommand}`,
        "-e",
        fakeSsh,
        "--",
        directory ? `${source}/` : source,
        `test:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
      ],
      {
        timeoutMs: 30_000,
        baseEnv: {
          ...process.env,
          HOME: home,
          PATH: `${tools}:${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_REAL_RSYNC: rsync,
          OPENCLAW_TEST_RECEIVER_ARGV: receiverArgvPath,
          OPENCLAW_TEST_SSH_ARGV: sshArgvPath,
        },
      },
    );
    expect(result).toMatchObject({ termination: "exit", code: 0 });
    const receivedPath =
      mode === "workspace-root"
        ? path.join(receiverTarget, "payload.txt")
        : mode === "accepted-next"
          ? path.join(receiverTarget, path.basename(source))
          : receiverTarget;
    await expect(fs.readFile(receivedPath, "utf8")).resolves.toBe(contents);

    const sshArgv = await readArgv(sshArgvPath);
    expect(sshArgv.join(" ")).toMatch(
      /^node [A-Za-z0-9_./-]+ (?:workspace-root|git-pack|accepted-next) [A-Za-z0-9_-]+ [a-f0-9]{32} --server /u,
    );
    expect(sshArgv.at(-1)).toBe(WORKER_WORKSPACE_RSYNC_DESTINATION);
    expect(sshArgv.join(" ")).not.toContain(workspace);
    const receiverArgv = await readArgv(receiverArgvPath);
    expect(receiverArgv.at(-1)).toBe(receiverTarget);
    await expect(
      fs.access(path.join(home, WORKER_WORKSPACE_RSYNC_DESTINATION)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
