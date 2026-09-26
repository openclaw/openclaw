import type { Stats } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { expectRespondOk } from "./agents-mutate.test-support.js";

type AgentDeleteFilesystemHarness = {
  mocks: {
    resolveAgentWorkspaceDir: Mock<(cfg?: unknown, agentId?: string) => string>;
    fsRealpath: Mock<(pathname: string) => Promise<string>>;
    fsLstat: Mock<(...args: unknown[]) => Promise<Stats | null>>;
    fsReadlink: Mock<(pathname: string) => Promise<string>>;
    movePathToTrash: Mock<(pathname?: string) => Promise<string>>;
    fsRm: unknown;
    deleteWorkspaceState: unknown;
  };
  makeCall: (
    method: "agents.delete",
    params: Record<string, unknown>,
  ) => { respond: Mock; promise: Promise<void> | void };
  makeFileStat: () => Stats;
  expectNotTrashed: (pathname: string) => void;
  expectTrashedWithinParent: (pathname: string, declaredPath?: string) => void;
};

export function registerAgentDeleteFilesystemTests(harness: AgentDeleteFilesystemHarness): void {
  const { mocks, makeCall, makeFileStat, expectNotTrashed, expectTrashedWithinParent } = harness;
  describe("filesystem cleanup", () => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);

    it.skipIf(process.platform === "win32")(
      "does not trash a lexical decoy for a dangling workspace symlink",
      async () => {
        const actualFs =
          await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const base = await actualFs.realpath(tempDirs.make("openclaw-agent-delete-dangling-"));
        const workspaceLink = path.join(base, "workspace-link");
        const decoy = path.join(base, "missing");
        await actualFs.mkdir(path.join(base, "physical", "child"), { recursive: true });
        await actualFs.mkdir(decoy);
        await actualFs.symlink("physical/child", path.join(base, "alias"));
        await actualFs.symlink("alias/../missing", workspaceLink);
        mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) =>
          agentId === "test-agent" ? workspaceLink : `/workspace/${agentId ?? "unknown"}`,
        );
        mocks.fsRealpath.mockImplementation(async (pathname) =>
          pathname.startsWith(base) ? await actualFs.realpath(pathname) : pathname,
        );
        mocks.fsLstat.mockImplementation(async (pathname) =>
          String(pathname).startsWith(base)
            ? await actualFs.lstat(String(pathname))
            : makeFileStat(),
        );
        mocks.fsReadlink.mockImplementation(async (pathname) => await actualFs.readlink(pathname));

        const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
        await promise;

        expectRespondOk(respond, { ok: true });
        expectNotTrashed(decoy);
        expectTrashedWithinParent(workspaceLink);
        expect(mocks.deleteWorkspaceState).toHaveBeenCalled();
      },
    );

    it("reports trash failures without deleting the retained directory", async () => {
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const workspaceDir = await actualFs.realpath(
        tempDirs.make("openclaw-agent-delete-trash-failure-"),
      );
      mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) =>
        agentId === "test-agent" ? workspaceDir : `/workspace/${agentId ?? "unknown"}`,
      );
      mocks.movePathToTrash.mockImplementation(async (pathname) => {
        if (pathname === workspaceDir) {
          throw Object.assign(new Error("trash destination missing"), { code: "ENOENT" });
        }
        return "/trashed";
      });

      const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
      await promise;

      expectRespondOk(respond, {
        failed: [{ path: workspaceDir, reason: "trash destination missing" }],
      });
      await expect(actualFs.stat(workspaceDir)).resolves.toBeDefined();
      expect(mocks.fsRm).not.toHaveBeenCalled();
      expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    });
  });
}
