import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  insertRepositoryGitHubPublicationFixture as insertRepositoryGitHubPublication,
  readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication,
} from "../../gateway/github-publication-store.test-support.js";
import { repositoryGitHubPublicationDigest } from "../../gateway/github-repository-publication-store.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import type { RepositoryGitHubPublicationRow } from "../../state/github-publication-read.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withSessionHistoryBudgetSweepsForTest } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

let state: OpenClawTestState;
let stopObserving: (() => void) | undefined;
afterEach(async () => {
  stopObserving?.();
  stopObserving = undefined;
  try {
    await closeOpenClawAgentDatabasesAsync(state.root);
    closeOpenClawAgentDatabasesForTest(state.root);
  } finally {
    await closeStateDatabaseForTest();
    await state.cleanup();
  }
});

function row(databasePath: string, sql: string, ...values: SQLInputValue[]) {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
}

const sessionNode = (databasePath: string, key: string) =>
  row(databasePath, "SELECT current_session_id FROM session_nodes WHERE session_key = ?", key);
const transcriptCount = (databasePath: string, id: string) =>
  Number(
    row(databasePath, "SELECT count(*) AS count FROM transcript_events WHERE session_id = ?", id)
      ?.count,
  );
const registry = () =>
  listOpenClawRegisteredAgentDatabases({ env: state.env })
    .map(({ agentId, path: registeredPath }) => ({ agentId, path: registeredPath }))
    .toSorted((a, b) => a.path.localeCompare(b.path));

async function closeAndCheckLeases(testState: OpenClawTestState) {
  await closeOpenClawAgentDatabasesAsync(testState.root);
  closeOpenClawAgentDatabasesForTest(testState.root);
  const statePath = resolveOpenClawStateSqlitePath(testState.env);
  expect(row(statePath, "SELECT count(*) AS count FROM agent_database_leases")).toEqual({
    count: 0,
  });
}

function seedReceipt(agentId: string, sessionKey: string, sessionId: string): string {
  const requestId = randomUUID();
  const now = Date.now();
  const receipt: RepositoryGitHubPublicationRow = {
    request_id: requestId,
    idempotency_key: `owner-parity-${requestId}`,
    request_digest: "",
    session_id: sessionId,
    session_lifecycle_revision: null,
    requester_authority_json: null,
    session_key: sessionKey,
    agent_id: agentId,
    workspace_id: `workspace-${requestId}`,
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-detected",
    identity_profile_id: null,
    identity_account_id: 12345,
    identity_login: "synthetic-owner",
    title: null,
    body: null,
    push_repository: "example/synthetic-owner-proof",
    repository: "example/synthetic-owner-proof",
    base_branch: "main",
    branch: "proof/owner-parity",
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: null,
    checkpoint_digest: null,
    source_head_commit: null,
    source_index_tree: null,
    workspace_tree: null,
    status: "requested",
    execution_id: null,
    gateway_instance_id: null,
    head_commit: null,
    pushed_head_commit: null,
    pull_request_url: null,
    last_effect: null,
    effect_state: null,
    error_code: null,
    next_action: null,
    created_at_ms: now,
    updated_at_ms: now,
    reported_at_ms: null,
  };
  receipt.request_digest = repositoryGitHubPublicationDigest(receipt);
  insertRepositoryGitHubPublication(receipt, () => {});
  return requestId;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(kind: "shared" | "canonical-nonshared" | "custom-nonshared", bare = false) {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "minimal" });
  const storePath =
    kind === "canonical-nonshared"
      ? path.join(state.sessionsDir("main"), "sessions.json")
      : state.path("custom", kind === "shared" ? "shared.sqlite" : "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const databasePath =
    kind === "shared"
      ? storePath
      : resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env: state.env })
          .path;
  const options = { agentId: "main", env: state.env, path: databasePath };
  const scope = { agentId: "main", env: state.env, storePath };
  openOpenClawAgentDatabase(options);
  const victimKey = bare ? "unknown" : "agent:secondary:explicit:owner-parity";
  const victimAgent = bare ? "main" : "secondary";
  const victimId = "owner-parity-victim";
  const survivorKey = "agent:main:main";
  const survivorId = "owner-parity-survivor";
  const message = { role: "user", content: "owner parity transcript" };
  const archived = {
    sessionId: victimId,
    updatedAt: 1,
    archivedAt: 1,
    archiveReason: "active-session-cap" as const,
  };
  if (kind === "shared") {
    const victimScope = { ...scope, agentId: victimAgent, sessionKey: victimKey };
    replaceSessionEntrySync(victimScope, { sessionId: victimId, updatedAt: 1 });
    await appendTranscriptMessage({ ...victimScope, sessionId: victimId }, { message });
    replaceSessionEntrySync(victimScope, archived);
  } else {
    // Canonical low-level writers seed a foreign row rejected by public scope resolution.
    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, victimKey, archived);
      const transcript = { ...options, sessionKey: victimKey, sessionId: victimId };
      ensureTranscriptHeader(database, transcript, state.root);
      expect(
        appendTranscriptEventsInTransaction(database, transcript, [
          { type: "message", id: "owner-parity-message", message },
        ]),
      ).toBe(1);
    }, options);
  }
  replaceSessionEntrySync(
    { ...scope, sessionKey: survivorKey },
    { sessionId: survivorId, updatedAt: Date.now() },
  );
  // Join real seed maintenance with unchanged defaults, rather than disabling it.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await runExclusiveSqliteSessionWrite(
    resolveSqliteScope({ ...scope, sessionKey: "" }),
    async () => {},
    "session.history.eviction-prepare",
  );
  await enforceSqliteSessionHistoryDiskBudget({
    agentId: "main",
    storePath,
    mode: "enforce",
    maintenance: resolveMaintenanceConfigFromInput(),
  });
  const victimReceipt = seedReceipt(victimAgent, victimKey, victimId);
  const survivorReceipt = seedReceipt("main", survivorKey, survivorId);
  const secondaryCanonicalPath = resolveOpenClawAgentSqlitePath({
    agentId: "secondary",
    env: state.env,
  });
  const registryBefore = registry();
  expect(registryBefore).toContainEqual({ agentId: "main", path: databasePath });
  await closeAndCheckLeases(state);
  return {
    storePath,
    databasePath,
    victimKey,
    victimId,
    survivorKey,
    survivorId,
    victimReceipt,
    survivorReceipt,
    secondaryCanonicalPath,
    registryBefore,
  };
}

function observeVictim(f: Fixture) {
  const facts: Array<{
    mutation: SessionIdentityMutation;
    rowExists: boolean;
    receiptExists: boolean;
  }> = [];
  stopObserving = onSessionIdentityMutation((mutation) => {
    if (mutation.kind === "delete" && mutation.previous.sessionKeys.includes(f.victimKey)) {
      facts.push({
        mutation,
        rowExists: sessionNode(f.databasePath, f.victimKey) !== undefined,
        receiptExists: readRepositoryGitHubPublication(f.victimReceipt) !== undefined,
      });
    }
  });
  return facts;
}

function enforce(f: Fixture, agentId?: string) {
  return enforceSqliteSessionHistoryDiskBudget({
    ...(agentId !== undefined ? { agentId } : {}),
    storePath: f.storePath,
    mode: "enforce",
    maintenance: resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    }),
  });
}

async function assertCustody(f: Fixture) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
  expect(row(f.databasePath, "SELECT agent_id FROM schema_meta")).toEqual({ agent_id: "main" });
  expect(sessionNode(f.databasePath, f.survivorKey)).toEqual({ current_session_id: f.survivorId });
  expect(readRepositoryGitHubPublication(f.survivorReceipt)).toMatchObject({
    agent_id: "main",
    session_key: f.survivorKey,
    session_id: f.survivorId,
  });
  expect(fs.existsSync(f.secondaryCanonicalPath)).toBe(false);
  expect(registry()).toEqual(f.registryBefore);
  await closeAndCheckLeases(state);
}

describe("budget cap-entry logical ownership", () => {
  it.each([
    { name: "omitted qualified owner", explicit: false, bare: false, expectedAgent: "secondary" },
    { name: "explicit secondary owner", explicit: true, bare: false, expectedAgent: "secondary" },
    { name: "omitted canonical bare unknown", explicit: false, bare: true, expectedAgent: "main" },
  ] as const)(
    "deletes the matching receipt for $name in a shared physical main store",
    async (scenario) => {
      const f = await withSessionHistoryBudgetSweepsForTest(() => fixture("shared", scenario.bare));
      const file = fs.statSync(f.databasePath, { bigint: true });
      const facts = observeVictim(f);
      const result = await enforce(f, scenario.explicit ? "secondary" : undefined);
      expect(result?.removedEntries).toBe(1);
      expect(sessionNode(f.databasePath, f.victimKey)).toBeUndefined();
      expect(
        row(
          f.databasePath,
          "SELECT session_id FROM session_windows WHERE session_id = ?",
          f.victimId,
        ),
      ).toBeUndefined();
      expect(readRepositoryGitHubPublication(f.victimReceipt)).toBeUndefined();
      // agentId is fallback metadata for qualified keys, not authorization evidence.
      expect(facts).toEqual([
        {
          mutation: {
            agentId: scenario.expectedAgent,
            databaseIdentity: `${file.dev}:${file.ino}`,
            kind: "delete",
            previous: { sessionId: f.victimId, sessionKeys: [f.victimKey] },
          },
          rowExists: false,
          receiptExists: true,
        },
      ]);
      await assertCustody(f);
    },
  );

  it.each(["canonical-nonshared", "custom-nonshared"] as const)(
    "rejects a foreign candidate in a %s store without retargeting cleanup",
    async (kind) => {
      const f = await withSessionHistoryBudgetSweepsForTest(() => fixture(kind));
      const facts = observeVictim(f);
      const suffixPath =
        kind === "custom-nonshared"
          ? resolveSqliteTargetFromSessionStorePath(f.storePath, {
              agentId: "secondary",
              env: state.env,
            }).path
          : undefined;
      if (suffixPath) {
        expect(suffixPath).not.toBe(f.databasePath);
        expect(fs.existsSync(suffixPath)).toBe(false);
      }
      await expect(enforce(f)).rejects.toThrow(
        "SQLite session store path belongs to agent main; requested agent secondary.",
      );
      expect(sessionNode(f.databasePath, f.victimKey)).toEqual({ current_session_id: f.victimId });
      expect(transcriptCount(f.databasePath, f.victimId)).toBeGreaterThan(0);
      expect(readRepositoryGitHubPublication(f.victimReceipt)).toMatchObject({
        agent_id: "secondary",
        session_key: f.victimKey,
        session_id: f.victimId,
      });
      expect(facts).toEqual([]);
      if (suffixPath) {
        expect(fs.existsSync(suffixPath)).toBe(false);
      }
      await assertCustody(f);
    },
  );
});
