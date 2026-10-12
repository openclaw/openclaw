import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTranscriptWriteSequence } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import { createRequest, createTranscriptCommitIdentity } from "./transcript-commit.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let store: ReturnType<typeof createWorkerTranscriptCommitStore>;

beforeAll(async () => {
  const root = directories.make("incognito-worker-transcript-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const database = openOpenClawStateDatabase();
  store = createWorkerTranscriptCommitStore({ database });
  actor = await openIncognitoTestActor({ OPENCLAW_STATE_DIR: root }, authority);
});
useIncognitoNoHostSql();
afterAll(async () => {
  await actor?.close();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("commits an actor batch through the service and recovers its receipt without duplicate bytes", async () => {
  const sessionId = "worker-actor-batch";
  const sessionKey = `agent:main:dashboard:incognito-${sessionId}`;
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId, updatedAt: Date.now(), lifecycleRevision: "actor-window", incognito: true },
  });
  const sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: actor.path,
    expectedLifecycleRevision: "actor-window",
  };
  let interrupt = true;
  const committer = createWorkerTranscriptCommitter({
    getConfig: () => ({}),
    store: {
      ...store,
      complete: (input, assertCurrent) => {
        if (interrupt) {
          interrupt = false;
          throw new Error("synthetic receipt interruption");
        }
        return store.complete(input, assertCurrent);
      },
    },
  });
  await withIncognitoSessionActor(actor, async () => {
    const request = {
      identity: createTranscriptCommitIdentity(sessionId, 7),
      sessionTarget,
      request: createRequest(),
      assertCurrent: () => undefined,
    };
    await expect(committer.commit(request)).rejects.toThrow("synthetic receipt interruption");
    const recovered = await committer.commit(request);
    expect(recovered).toMatchObject({ ok: true, result: { entryIds: expect.any(Array) } });
    expect(await committer.commit(request)).toEqual(recovered);
    const events = await withTranscriptWriteSequence(sessionTarget, (write) => write.readEvents());
    const messages = events
      .filter(isIndexedSessionEntry)
      .filter((event) => event.type === "message");
    expect(messages).toHaveLength(3);
    expect(messages.map((event) => event.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messages[0]).toMatchObject({
      message: { content: [{ type: "text", text: "Inspect the workspace" }] },
    });
  });
});

it("refuses an actor batch when placement authority ends after ledger reservation", async () => {
  const sessionId = "worker-actor-revoked";
  const sessionKey = `agent:main:dashboard:incognito-${sessionId}`;
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId, updatedAt: Date.now(), incognito: true },
  });
  const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath: actor.path };
  let current = true;
  const committer = createWorkerTranscriptCommitter({
    getConfig: () => ({}),
    store: {
      ...store,
      begin: async (...args) => {
        const result = await store.begin(...args);
        current = false;
        return result;
      },
    },
  });
  await withIncognitoSessionActor(actor, async () => {
    await expect(
      committer.commit({
        identity: createTranscriptCommitIdentity(sessionId, 7),
        sessionTarget,
        request: createRequest(),
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement owner ended");
          }
          return undefined;
        },
      }),
    ).rejects.toThrow("placement owner ended");
    const events = await withTranscriptWriteSequence(sessionTarget, (write) => write.readEvents());
    expect(
      events.filter(isIndexedSessionEntry).filter((event) => event.type === "message"),
    ).toEqual([]);
  });
});
