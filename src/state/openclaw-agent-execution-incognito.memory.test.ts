import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as sessionFiles from "../../packages/memory-host-sdk/src/host/session-files.js";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
} from "../../packages/memory-host-sdk/src/host/session-files.js";
import { readSessionResetRecallCutoff } from "../../packages/memory-host-sdk/src/host/session-reset-recall-read.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { createIncognitoSessionComputeReader } from "../gateway/session-history-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-memory-wiring-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function session(name: string, grant = authority, owner = actor) {
  const target = {
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    lifecycleRevision: "initial",
  };
  await actor.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: {
      sessionId: name,
      lifecycleRevision: "initial",
      incognito: true,
      createdAt: 10000,
      updatedAt: 10000,
    },
  });
  for (const content of ["first Memory source", "second Memory source"]) {
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...target,
        fence: { expectedLifecycleRevision: target.lifecycleRevision },
        message: {
          role: "assistant",
          content: [
            { type: "text", text: content },
            { type: "image", data: "synthetic-image", mimeType: "image/png" },
          ],
          timestamp: 10000,
        },
      },
    });
  }
  const reader = await createIncognitoSessionComputeReader({
    actor: owner,
    authority: grant,
    target,
  });
  return { target, reader, scope: { ...target, agentId: actor.agentId, storePath: actor.path } };
}

it("wires Memory callbacks, corpus and reset recall through the captured actor without caller SQL", async () => {
  const { reader, scope } = await session("callbacks-corpus");
  const observed: unknown[] = [];
  const entry = await buildSessionEntry(
    "actor-memory",
    {
      ...scope,
      parseYieldEveryLines: 1,
      onTranscriptMessage: (message) => {
        observed.push(message);
      },
    },
    reader,
  );
  expect(observed).toHaveLength(2);
  expect(observed[0]).toMatchObject({
    content: [
      { type: "text", text: "first Memory source" },
      { type: "image", data: "synthetic-image", mimeType: "image/png" },
    ],
  });
  expect(entry?.content).toBe("Assistant: first Memory source\nAssistant: second Memory source");
  expect(await readSessionResetRecallCutoff(scope, reader)).toEqual({ state: "absent" });
  const corpus = await listSessionTranscriptCorpusEntriesForAgent(
    "main",
    { includeRetainedSqlite: true },
    reader,
  );
  expect(corpus).toContainEqual(
    expect.objectContaining({
      agentId: "main",
      sessionId: scope.sessionId,
      sessionKey: scope.sessionKey,
      storePath: actor.path,
      artifactKind: "active-session",
      transcriptSource: "sqlite",
      contentRevision: expect.stringMatching(/^sqlite:/),
    }),
  );
  await expect(listSessionTranscriptCorpusEntriesForAgent("foreign", {}, reader)).rejects.toThrow(
    "another agent",
  );
});

it("checks current authority before each Memory callback and refuses the parsed result after revocation", async () => {
  let current = true;
  const grant: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!current) {
        throw new Error("Memory authority revoked");
      }
    },
  };
  const { reader, scope } = await session("callback-revocation", grant);
  const observed: unknown[] = [];
  await expect(
    buildSessionEntry(
      "actor-memory",
      {
        ...scope,
        onTranscriptMessage(message) {
          observed.push(message);
          current = false;
        },
      },
      reader,
    ),
  ).rejects.toThrow("Memory authority revoked");
  expect(observed).toHaveLength(1);
});

it("refuses Memory disclosure after an intervening actor transcript write", async () => {
  const { reader, scope, target } = await session("callback-rewrite");
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const project = sessionFiles.buildSessionEntryFromSnapshot;
  const paused = vi
    .spyOn(sessionFiles, "buildSessionEntryFromSnapshot")
    .mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return project(...args);
    });
  const reading = buildSessionEntry("actor-memory", scope, reader);
  const rejected = expect(reading).rejects.toThrow("snapshot changed");
  try {
    await awaitGateBeforeSettlement(entered.promise, reading, "Memory projection was not entered");
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...target,
        fence: { expectedLifecycleRevision: target.lifecycleRevision },
        message: { role: "assistant", content: "intervening change" },
      },
    });
    resume.resolve();
    await rejected;
  } finally {
    resume.resolve();
    await reading.catch(() => undefined);
    paused.mockRestore();
  }
});

it("joins accepted Memory parsing before releasing its original actor borrow", async () => {
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(borrowed);
  const { reader, scope } = await session("callback-release", authority, borrowed);
  let releasing: Promise<void> | undefined;
  let released = false;
  try {
    await expect(
      buildSessionEntry(
        "actor-memory",
        {
          ...scope,
          onTranscriptMessage() {
            releasing ??= borrowed.release().then(() => {
              released = true;
            });
            expect(released).toBe(false);
          },
        },
        reader,
      ),
    ).rejects.toThrow("released");
    await releasing;
    expect(released).toBe(true);
  } finally {
    await borrowed.release();
  }
});

it("authorizes every corpus session in the actor grant before returning sibling metadata", async () => {
  const selected = await session("corpus-selected");
  const sibling = await session("corpus-sibling");
  const command = {
    type: "session.history.memory-corpus" as const,
    input: {
      ...selected.target,
      sessionKeys: [selected.target.sessionKey, sibling.target.sessionKey],
      scope: {
        cfg: {},
        env,
        normalizedAgentId: actor.agentId,
        storePath: actor.path,
        isSharedFixedStore: false,
        artifactDirs: [],
      },
      options: {},
    },
  };
  await expect(
    actor.sessions.history(
      {
        assertCurrent() {},
        authorize(_stage, facts) {
          if (facts.sessionKey !== selected.target.sessionKey) {
            throw new Error("Sibling corpus access revoked");
          }
        },
      },
      command,
    ),
  ).rejects.toThrow("Sibling corpus access revoked");
  const rows = await actor.sessions.history(authority, {
    ...command,
    input: { ...command.input, sessionKeys: [selected.target.sessionKey] },
  });
  expect(rows.map((row) => row.sessionKey)).toEqual([selected.target.sessionKey]);
});
