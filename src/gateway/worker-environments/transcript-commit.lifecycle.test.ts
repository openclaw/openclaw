import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WorkerTranscriptMessage } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  updateSessionEntry,
  upsertSessionEntryCore,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  applyPreparedTranscriptCommit,
  prepareTranscriptCommit,
  type TranscriptCommitInput,
} from "./transcript-commit.kernel.js";

let root: string;
let storePath: string;
let store: ReturnType<typeof createWorkerTranscriptCommitStore>;
let committer: ReturnType<typeof createWorkerTranscriptCommitter>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await waitForSessionTranscriptIndexReconcilesInStateDir(root);
    await closeOpenClawAgentDatabasesAsync(root);
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeAll(() => {
  root = tempDirs.make("worker-transcript-lifecycle-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  store = createWorkerTranscriptCommitStore({ database: openOpenClawStateDatabase() });
  committer = createWorkerTranscriptCommitter({
    getConfig: () => ({
      agents: { entries: { main: {} } },
      session: { store: storePath },
    }),
    store,
  });
});
afterEach(() => vi.restoreAllMocks());

async function fixture(name: string) {
  const sessionId = `lifecycle-${name}`;
  const sessionKey = `agent:main:${sessionId}`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, lifecycleRevision: "original", updatedAt: 10 },
  );
  const sessionTarget = await resolveSessionTranscriptRuntimeTarget({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  });
  const identity: WorkerConnectionIdentity = {
    environmentId: "worker-a",
    credentialHash: "synthetic-credential-hash",
    bundleHash: "b".repeat(64),
    sessionId,
    runId: `run-${name}`,
    turnClaim: null,
    ownerEpoch: 7,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-transcript-commit-v1"],
    credentialExpiresAtMs: 10_000,
  };
  const message: Extract<WorkerTranscriptMessage, { role: "user" }> = {
    role: "user",
    content: [{ type: "text", text: "Keep the admitted transcript owner" }],
    timestamp: 100,
  };
  return { sessionTarget, identity, message };
}

it.each([false, true])(
  "pins an unbound transcript lifecycle through preparation (replacement: %s)",
  async (replaceLifecycle) => {
    const { sessionTarget, message } = await fixture(`prepare-${replaceLifecycle}`);
    const input: TranscriptCommitInput = {
      scope: sessionTarget,
      lifecycleRevision: undefined,
      requestedBaseLeafId: null,
      recoverPersistedBatch: false,
      messages: [{ ...message, idempotencyKey: "worker-unbound-lifecycle" }],
      cwd: root,
    };
    const prepared = await withTranscriptWriteTransaction(sessionTarget, () =>
      prepareTranscriptCommit(input),
    );
    expect(prepared.result).toMatchObject({ ok: true, lifecycleRevision: "original" });
    if (replaceLifecycle) {
      await updateSessionEntry(sessionTarget, () => ({ lifecycleRevision: "replacement" }));
    }
    const outcome = await withTranscriptWriteTransaction(sessionTarget, () =>
      applyPreparedTranscriptCommit(input, prepared, input.messages, () => undefined),
    );
    expect(outcome).toMatchObject(
      replaceLifecycle
        ? { ok: false, reason: "invalid-batch" }
        : { ok: true, lifecycleRevision: "original" },
    );
    const entries = (await SessionManager.openAsync(sessionTarget)).getEntries();
    expect(entries).toHaveLength(replaceLifecycle ? 0 : 1);
    if (!replaceLifecycle) {
      expect(entries[0]).toMatchObject({
        type: "message",
        message: { content: [{ type: "text", text: "Keep the admitted transcript owner" }] },
      });
    }
  },
);

it("publishes the revision captured by an unbound commit", async () => {
  const { sessionTarget, identity, message } = await fixture("publication");
  const updates: Array<string | undefined> = [];
  const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    if (update.sessionId === sessionTarget.sessionId) {
      updates.push(update.lifecycleRevision);
    }
  });
  try {
    await expect(
      committer.commit({
        identity,
        sessionTarget,
        assertCurrent: () => undefined,
        request: { runEpoch: 7, seq: 1, baseLeafId: null, messages: [message] },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(updates).toEqual(["original"]);
  } finally {
    unsubscribe();
  }
});

it("releases an unused transcript reservation when its authority closes", async () => {
  const { sessionTarget, identity, message } = await fixture("cancellation");
  let current = true;
  const begin = store.begin.bind(store);
  vi.spyOn(store, "begin").mockImplementationOnce(async (...args) => {
    const result = await begin(...args);
    current = false;
    return result;
  });
  const request = { runEpoch: 7, seq: 1, baseLeafId: null, messages: [message] };
  await expect(
    committer.commit({
      identity,
      sessionTarget,
      request,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Worker owner closed after reservation");
        }
      },
    }),
  ).rejects.toThrow("Worker owner closed after reservation");
  expect((await SessionManager.openAsync(sessionTarget)).getEntries()).toEqual([]);
  await expect(
    committer.commit({
      identity,
      sessionTarget,
      assertCurrent: () => undefined,
      request: {
        ...request,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Fresh request after cancellation" }],
            timestamp: 101,
          },
        ],
      },
    }),
  ).resolves.toMatchObject({ ok: true });
});
