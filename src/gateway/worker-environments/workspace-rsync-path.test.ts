import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
const BUNDLE_HASH = "a".repeat(64);
const readArgv = async (file: string) =>
  (await fs.readFile(file, "utf8")).split("\0").filter(Boolean);
const receiverScripts = {
  rsync:
    '#!/bin/sh\nset -eu\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_RECEIVER_ARGV"\nexec "$OPENCLAW_TEST_REAL_RSYNC" "$@"\n',
  ssh: '#!/bin/sh\nset -eu\nshift\nprintf "%s\\0" "$@" > "$OPENCLAW_TEST_SSH_ARGV"\ncd "$HOME"\nexec sh -c "$*"\n',
};

describe.skipIf(process.platform === "win32")("workspace rsync receiver path", () => {
  it.each([{ mode: "workspace-root" }, { mode: "git-pack" }, { mode: "accepted-next" }] as const)(
    "crosses the real rsync and OpenSSH argv boundary for $mode",
    async ({ mode }) => {
      const directory = mode === "workspace-root";
      const root = path.join(tempDirs.make("openclaw-rsync-path-"), "paths with spaces");
      const home = path.join(root, "remote home");
      const workspace = path.join(home, ".openclaw-worker/workspaces/env/session/1");
      const source = path.join(root, directory ? "source dir" : "input.bin");
      const tools = tempDirs.make("openclaw-rsync-tools-");
      const sshArgvPath = path.join(root, "ssh-argv");
      const receiverArgvPath = path.join(root, "receiver-argv");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(tools, { recursive: true });
      const canonicalHome = await fs.realpath(home);
      const canonicalWorkspace = await fs.realpath(workspace);
      const remoteRelative = path.posix.relative(canonicalHome, canonicalWorkspace);
      const nonce = "b".repeat(32);
      const receiverEntryPath = workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH);
      await prepareLocalWorkspaceRsyncReceiver(path.join(canonicalHome, receiverEntryPath));

      const resolvedRsync = await runCommandWithTimeout(["sh", "-c", "command -v rsync"], {
        timeoutMs: 10_000,
      });
      expect(resolvedRsync).toMatchObject({ termination: "exit", code: 0 });
      const rsync = resolvedRsync.stdout.trim();
      for (const [name, script] of Object.entries(receiverScripts)) {
        await fs.writeFile(path.join(tools, name), script, { mode: 0o755 });
      }
      const fakeSsh = path.join(tools, "ssh");

      let receiverCommand: string;
      let receiverTarget: string;
      if (mode === "accepted-next") {
        const workspaceKey = createHash("sha256").update(canonicalWorkspace).digest("hex");
        const transaction = path.join(
          path.dirname(canonicalWorkspace),
          `.openclaw-accepted-${workspaceKey}-${nonce}`,
        );
        receiverTarget = path.join(transaction, "next");
        await fs.mkdir(receiverTarget, { recursive: true });
        await fs.writeFile(
          path.join(transaction, "phase.json"),
          JSON.stringify({ version: 1, nonce, phase: "begun" }),
        );
        receiverCommand = workerAcceptedWorkspaceRsyncReceiverPath({
          receiverEntryPath,
          remoteWorkspaceDir: canonicalWorkspace,
          nonce,
        });
      } else {
        receiverTarget =
          mode === "git-pack"
            ? path.join(canonicalWorkspace, ".openclaw-base.pack")
            : canonicalWorkspace;
        receiverCommand = createWorkerWorkspaceRsyncReceiverPathFactory({
          receiverEntryPath,
          remoteWorkspaceDir: canonicalWorkspace,
          canonicalHome,
          remoteRelative,
        })(mode);
      }

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
            HOME: canonicalHome,
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
      expect(sshArgv.join(" ")).not.toContain(canonicalWorkspace);
      const receiverArgv = await readArgv(receiverArgvPath);
      expect(receiverArgv.at(-1)).toBe(receiverTarget);
      await expect(
        fs.access(path.join(canonicalHome, WORKER_WORKSPACE_RSYNC_DESTINATION)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
