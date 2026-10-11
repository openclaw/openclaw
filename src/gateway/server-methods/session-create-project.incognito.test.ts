import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareSessionWorkspaceForRun } from "./session-create-project.js";

const authority = { assertCurrent() {} };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let workspace: string;
let cfg: OpenClawConfig;
const ownedKeys = new Set<string>();

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-actor-" });
  workspace = await initializeManagedWorktreeTestRepository(state.root);
  cfg = { agents: { entries: { main: { workspace } } } };
  setRuntimeConfigSnapshot(cfg);
  actor = await openIncognitoTestActor(state.env, authority);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const worktrees = new ManagedWorktreeService({ env: state.env });
  for (const key of ownedKeys) {
    const record = await worktrees.findLiveByOwner("session", key);
    if (record) {
      await worktrees.remove({ id: record.id, reason: "test-cleanup", allowSnapshotLoss: true });
    }
  }
  ownedKeys.clear();
});
afterAll(async () => {
  await actor?.close();
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
  ownedKeys.add(sessionKey);
  await actor.sessions.create(authority, { sessionKey, entry });
  return { sessionKey, entry };
}

function prepare(sessionKey: string, entry: InternalSessionEntry) {
  return withIncognitoSessionActor(actor, () =>
    prepareSessionWorkspaceForRun({
      entry,
      cfg,
      agentId: "main",
      runId: `run-${entry.sessionId}`,
      sessionKey,
      storePath: actor.path,
      context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      signal: new AbortController().signal,
      assertCurrent: () => authority.assertCurrent(),
      runSetupScript: false,
    }),
  );
}

it("materializes and commits a bound first-turn worktree without host session SQL", async () => {
  const { sessionKey, entry } = await createPendingSession("first-turn");
  const sql = observeHostDataSql();
  try {
    await prepare(sessionKey, entry);
    const saved: InternalSessionEntry | undefined = (
      await actor.sessions.read(authority, { sessionKey })
    ).entry;
    assert(saved?.worktree);
    const record = await new ManagedWorktreeService({ env: state.env }).findLiveByOwner(
      "session",
      sessionKey,
    );
    assert(record);
    expect(record).toMatchObject({ id: saved.worktree.id, name: "first-turn", baseRef: "main" });
    expect(saved).toMatchObject({
      sessionId: entry.sessionId,
      sessionRoot: record.path,
      spawnedCwd: record.path,
      worktree: { repoRoot: workspace },
    });
    expect(saved.pendingWorktree).toBeUndefined();
    expect(entry.worktree).toEqual(saved.worktree);
    expect(await readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
  } finally {
    sql.restore();
  }
});

it.each(["lifecycle", "intent"] as const)(
  "refuses a changed %s after resolving the repository and before workspace allocation",
  async (change) => {
    const { sessionKey, entry } = await createPendingSession(`changed-${change}`);
    const pendingWorktree = entry.pendingWorktree;
    assert(pendingWorktree);
    const entered = createDeferred();
    const resume = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- The real method is called with its original receiver below.
    const resolveRepository = ManagedWorktreeService.prototype.resolveRepositoryPaths;
    vi.spyOn(ManagedWorktreeService.prototype, "resolveRepositoryPaths").mockImplementationOnce(
      async function (this: ManagedWorktreeService, ...args) {
        const resolved = await resolveRepository.apply(this, args);
        entered.resolve();
        await resume.promise;
        return resolved;
      },
    );
    const pending = prepare(sessionKey, entry);
    const settled = pending.then(
      () => ({ completed: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "repository was not resolved");
      await withIncognitoSessionActor(actor, () =>
        patchSessionEntryCore({ sessionKey, storePath: actor.path }, () =>
          change === "lifecycle"
            ? { lifecycleRevision: "replacement" }
            : { pendingWorktree: { ...pendingWorktree, name: "replacement" } },
        ),
      );
    } finally {
      resume.resolve();
      await settled;
    }
    expect(await settled).toMatchObject({
      error: expect.objectContaining({ message: expect.stringMatching(/changed|current/i) }),
    });
    const saved: InternalSessionEntry | undefined = (
      await actor.sessions.read(authority, { sessionKey })
    ).entry;
    expect(saved?.worktree).toBeUndefined();
    expect(saved?.pendingWorktree?.name).toBe(
      change === "intent" ? "replacement" : `changed-${change}`,
    );
    expect(
      await new ManagedWorktreeService({ env: state.env }).findLiveByOwner("session", sessionKey),
    ).toBeUndefined();
  },
);
