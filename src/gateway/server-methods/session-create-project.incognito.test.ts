import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as repositoryPaths from "../../agents/worktrees/repository-paths.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareSessionWorkspaceForRun } from "./session-create-project.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let storePath: string;
let workspace: string;
let cfg: OpenClawConfig;
let worktrees: ManagedWorktreeService;

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-actor-" });
  workspace = await initializeManagedWorktreeTestRepository(state.root);
  cfg = { agents: { entries: { main: { workspace } } } };
  setRuntimeConfigSnapshot(cfg);
  storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
  worktrees = new ManagedWorktreeService({ env: state.env });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  clearRuntimeConfigSnapshot();
  await state?.cleanup();
});

async function createPendingSession(name: string) {
  const sessionKey = `agent:main:dashboard:incognito-workspace-${name}`;
  const entry: InternalSessionEntry = {
    sessionId: name,
    updatedAt: Date.now(),
    incognito: true,
    pendingWorktree: { workspace, name, baseRef: "main", titleSource: name },
  };
  onTestFinished(async () => {
    const record = await worktrees.findLiveByOwner("session", sessionKey);
    if (record) {
      await worktrees.remove({ id: record.id, reason: "test-cleanup", allowSnapshotLoss: true });
    }
  });
  const target = { sessionKey, storePath };
  await replaceSessionEntry(target, entry);
  return {
    entry,
    target,
    read: () => loadSessionEntry(target),
    findWorktree: () => worktrees.findLiveByOwner("session", sessionKey),
    prepare: () =>
      prepareSessionWorkspaceForRun({
        ...target,
        entry,
        cfg,
        agentId: "main",
        runId: `run-${name}`,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        signal: new AbortController().signal,
        assertCurrent() {},
        runSetupScript: false,
      }),
  };
}

it("materializes and commits an unbound first-turn worktree without host session SQL", async () => {
  const session = await createPendingSession("first-turn");
  const sql = observeHostDataSql();
  await session.prepare();
  const saved = session.read();
  assert(saved?.worktree);
  const record = await session.findWorktree();
  assert(record);
  expect(record).toMatchObject({ id: saved.worktree.id, name: "first-turn", baseRef: "main" });
  expect(saved).toMatchObject({
    sessionId: session.entry.sessionId,
    sessionRoot: record.path,
    spawnedCwd: record.path,
    worktree: { repoRoot: workspace },
  });
  expect(saved.pendingWorktree).toBeUndefined();
  expect(session.entry.worktree).toEqual(saved.worktree);
  expect(await readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
  expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
});

it.each(["lifecycle", "intent"] as const)(
  "refuses a changed %s after resolving the repository and before workspace allocation",
  async (change) => {
    const session = await createPendingSession(`changed-${change}`);
    const pendingWorktree = session.entry.pendingWorktree;
    assert(pendingWorktree);
    const entered = createDeferred();
    const resume = createDeferred();
    const resolveRepository = repositoryPaths.resolveRepository;
    vi.spyOn(repositoryPaths, "resolveRepository").mockImplementationOnce(async (...args) => {
      const resolved = await resolveRepository(...args);
      entered.resolve();
      await resume.promise;
      return resolved;
    });
    const pending = session.prepare();
    const settled = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "repository was not resolved");
      await patchSessionEntryCore(session.target, () =>
        change === "lifecycle"
          ? { lifecycleRevision: "replacement" }
          : { pendingWorktree: { ...pendingWorktree, name: "replacement" } },
      );
    } finally {
      resume.resolve();
      await settled;
    }
    expect(await settled).toMatchObject({ message: expect.stringMatching(/changed|current/i) });
    const saved = session.read();
    expect(saved?.worktree).toBeUndefined();
    expect(saved?.pendingWorktree?.name).toBe(
      change === "intent" ? "replacement" : `changed-${change}`,
    );
    expect(await session.findWorktree()).toBeUndefined();
  },
);
