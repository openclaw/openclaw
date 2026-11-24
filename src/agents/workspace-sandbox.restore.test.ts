import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAttemptWorkspaceSandbox } from "./workspace-sandbox.js";
import { ManagedWorktreeService } from "./worktrees/service.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./worktrees/service.test-support.js";

it.each(["subagent", "manual", "owner-mismatch"])(
  "refuses a turn until explicit worktree restoration (%s)",
  async (scenario) => {
    await withOpenClawTestState({ label: "worktree-next-turn" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const repoRoot = await initializeManagedWorktreeTestRepository(state.root);
      const sessionKey = scenario === "subagent" ? "agent:main:subagent:child" : "agent:main:task";
      const record = await materializeManagedWorktreeFixture({
        env: state.env,
        stateDir: state.stateDir,
        repoRoot,
        name: "resume",
        now: 1,
        ownerKind: "session",
        ownerId: scenario === "owner-mismatch" ? "agent:main:other" : sessionKey,
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "resume",
          updatedAt: 1,
          worktree: { id: record.id, repoRoot, branch: record.branch },
        },
      );
      const service = new ManagedWorktreeService({ env: state.env });
      await service.remove({ id: record.id, reason: "test" });
      if (scenario === "manual") {
        await service.restore({ id: record.id });
        // A shell deletion leaves both the live registry row and Git registration behind.
        await fs.rm(record.path, { recursive: true });
      }
      const prepare = () =>
        resolveAttemptWorkspaceSandbox({
          workspaceDir: record.path,
          sessionId: "resume",
          sessionKey,
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        });
      await expect(prepare()).rejects.toThrow(
        scenario === "owner-mismatch"
          ? "Session worktree owner changed"
          : `This session's worktree was removed by cleanup or deletion. Use Restore in Settings > Worktrees (worktrees.restore), or start a new session. Worktree: ${record.id}.`,
      );
      await expect(fs.access(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
