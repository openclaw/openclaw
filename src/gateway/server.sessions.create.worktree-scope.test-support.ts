import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { borrowOpenClawStateDatabaseForAsyncRead } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { copyGitWorkspace } from "./server.sessions.create.projects.test-support.js";
import { disposeSessionReadContexts } from "./session-read-contexts.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

export async function expectNonAdminWorktreeSetupIsSkipped(params: {
  workspaceTemplate: string;
  prepareSessionStore: () => Promise<unknown>;
}) {
  // The suite Gateway can retain readers while this case selects its own state directory.
  const suiteRead = expectDefined(
    borrowOpenClawStateDatabaseForAsyncRead(openOpenClawStateDatabase().path),
    "suite database read",
  );
  try {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-worktree-setup-scope-" },
      async ({ root }) => {
        const workspace = await copyGitWorkspace(params.workspaceTemplate, root);
        await fs.mkdir(path.join(workspace, ".openclaw"), { recursive: true });
        const setupScript = path.join(workspace, ".openclaw", "worktree-setup.sh");
        await fs.writeFile(setupScript, "#!/bin/sh\ntouch setup-marker.txt\n");
        await fs.chmod(setupScript, 0o755);
        let worktreeId: string | undefined;
        try {
          testState.agentConfig = { workspace };
          await params.prepareSessionStore();
          const created = await directSessionReq<{
            key: string;
            worktree: { id: string; path: string; branch: string };
          }>(
            "sessions.create",
            { agentId: "main", worktree: true },
            { client: { connect: { scopes: ["operator.write"] } } as never },
          );
          expect(created.ok).toBe(true);
          const worktree = created.payload?.worktree.path;
          if (!worktree) {
            throw new Error("expected worktree path");
          }
          worktreeId = created.payload?.worktree.id;
          // Write-scoped callers get provisioning but never repo-script execution.
          await expect(fs.stat(path.join(worktree, "setup-marker.txt"))).rejects.toThrow();
        } finally {
          try {
            if (worktreeId) {
              await managedWorktrees.remove({
                id: worktreeId,
                reason: "test-cleanup",
                allowSnapshotLoss: true,
              });
            }
          } finally {
            try {
              await disposeSessionReadContexts();
            } finally {
              testState.agentConfig = undefined;
            }
          }
        }
      },
    );
    suiteRead.assertCurrent();
  } finally {
    suiteRead.release();
  }
}
