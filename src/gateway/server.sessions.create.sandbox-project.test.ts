import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("sessions.create rejects direct outside project access but admits a managed sandbox worktree", async () => {
  const root = tempDirs.make("openclaw-session-sandbox-project-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside });

  for (const worktree of [false, true]) {
    const created = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", {
      projectId: project.id,
      ...(worktree ? { worktree: true } : {}),
    });
    if (worktree) {
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const payload = expectDefined(created.payload, "managed sandbox session payload");
      const record = managedWorktrees.findLiveByOwner("session", payload.key);
      expect(record).toMatchObject({
        id: payload.worktree.id,
        path: payload.worktree.path,
        repoRoot: outside,
      });
      expect(payload.worktree.path).not.toBe(outside);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: payload.key, storePath }),
      ).toMatchObject({
        worktree: { id: payload.worktree.id },
      });
      expect(await fs.readFile(path.join(payload.worktree.path, "README.md"), "utf8")).toBe(
        "outside\n",
      );
      continue;
    }
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create project is outside the sandboxed agent workspace",
      },
    });
  }
});
