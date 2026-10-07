import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOwnedStdioProcess, createOwnedStdioProcess } from "../owned-stdio.js";
import { createProcessSupervisor } from "../supervisor/supervisor.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const executable = process.execPath;
let removedNode: string;
let stableNode: string;

beforeEach(async () => {
  const prefix = tempDirs.make("openclaw-child-node-");
  removedNode = path.join(prefix, "Cellar", "node", "26.8.1", "bin", "node");
  stableNode = path.join(prefix, "opt", "node", "bin", "node");
  await mkdir(path.dirname(removedNode), { recursive: true });
  await mkdir(path.dirname(stableNode), { recursive: true });
  await symlink(executable, removedNode);
  await symlink(executable, stableNode);
  process.execPath = removedNode;
  await rm(removedNode);
});
afterEach(() => {
  process.execPath = executable;
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "children after a Homebrew Node upgrade",
  () => {
    it("runs exec and owned MCP stdio through the replacement runtime", async () => {
      const supervisor = createProcessSupervisor();
      try {
        const run = await supervisor.spawn({ mode: "anchored-shell", command: "printf exec-ok" });
        await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "exec-ok" });
        const child = await createOwnedStdioProcess({ argv: ["/bin/sh", "-c", "printf mcp-ok"] });
        let stdout = "";
        child.onStdout((chunk) => (stdout += chunk));
        try {
          await expect(child.wait()).resolves.toMatchObject({ code: 0 });
          expect(stdout).toBe("mcp-ok");
        } finally {
          await closeOwnedStdioProcess(child);
        }
        await rm(stableNode);
        await expect(createOwnedStdioProcess({ argv: ["/bin/sh", "-c", "true"] })).rejects.toThrow(
          "Restart the Gateway.",
        );
      } finally {
        await supervisor.shutdown();
      }
    });

    it.each(["darwin", "linux"] as const)(
      "keeps an explicitly selected worker binary and reports the restart action once (%s OOM policy)",
      async (platform) => {
        const oomScore = await import("../linux-oom-score.js");
        const prepare = oomScore.prepareOomScoreAdjustedSpawn;
        vi.spyOn(oomScore, "prepareOomScoreAdjustedSpawn").mockImplementation(
          (command, args, options) => prepare(command, args, { ...options, platform }),
        );
        const env = {
          PATH: tempDirs.make("openclaw-empty-path-"),
          OPENCLAW_CHILD_OOM_SCORE_ADJ: "1",
        };
        const log = await import("../supervisor/supervisor-log.runtime.js");
        const warning = vi
          .spyOn(log, "warnProcessSupervisorSpawnFailure")
          .mockImplementation(() => {});
        const supervisor = createProcessSupervisor();
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(
              supervisor.spawn({
                mode: "child",
                argv: [removedNode, "-e", "process.exit(0)"],
                env,
              }),
            ).rejects.toThrow("Gateway runtime is stale after Node upgrade:");
          }
          expect(warning).toHaveBeenCalledTimes(1);
          expect(warning).toHaveBeenCalledWith(expect.stringContaining("Restart the Gateway."));
        } finally {
          await supervisor.shutdown();
        }
      },
    );

    it("keeps the broker on the exact runtime and reports why it cannot start", async () => {
      const host = createSpawnBrokerHost({ nativeResources: true });
      try {
        await expect(host.ready()).rejects.toThrow("Gateway runtime is stale after Node upgrade:");
      } finally {
        await host.close();
      }
    });
  },
);
