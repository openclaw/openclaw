import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkerTranscriptCommitParamsSchema,
  WorkerTranscriptMessageSchema,
  type WorkerTranscriptMessage,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createNoisyPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildRuntimeContextCustomMessage } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
  updateSessionEntry,
  upsertSessionEntryCore,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createWorkerTranscriptRuntime } from "../../worker/embedded-agent-transcript.runtime.js";
import { prepareAgentRunUserTurn } from "../agent-turn/agent-run-user-turn.js";
import type { AgentTurnContext } from "../agent-turn/types.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  applyPreparedTranscriptCommit,
  prepareTranscriptCommit,
} from "./transcript-commit.kernel.js";
import {
  createInterruptedCommitter,
  createRequest,
  createTranscriptCommitIdentity,
  createTurnMessages,
  messageIdempotencyKey,
  PROVIDER_REPLAY,
  RUN_EPOCH,
  SESSION_ID,
  ZERO_USAGE,
} from "./transcript-commit.test-support.js";
import type { TranscriptCommitInput } from "./transcript-commit.types.js";

type WorkerTranscriptCommitter = ReturnType<typeof createWorkerTranscriptCommitter>;

const SESSION_KEY = "agent:main:worker-transcript";

const IDENTITY = createTranscriptCommitIdentity(SESSION_ID, RUN_EPOCH);

function requireAppendableWorkerMessage(
  message: unknown,
): Parameters<SessionManager["appendMessage"]>[0] {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("expected committed worker message");
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant" && role !== "toolResult" && role !== "user") {
    throw new Error("expected committed worker message");
  }
  return message as Parameters<SessionManager["appendMessage"]>[0];
}

describe("worker transcript commit application", () => {
  let root: string;
  let sessionsDir: string;
  let stateDatabasePath: string;
  let storePath: string;
  let sessionTarget: Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>>;
  let ADMITTED_OWNER: Omit<Parameters<WorkerTranscriptCommitter["commit"]>[0], "request">;
  let cfg: OpenClawConfig;
  let committer: WorkerTranscriptCommitter;
  let ledgerStore: WorkerTranscriptCommitStore;
  let unsubscribe: (() => void) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-turn-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    sessionsDir = path.join(root, "agents", "main", "sessions");
    storePath = path.join(sessionsDir, "sessions.json");
    cfg = {
      agents: { entries: { main: {} } },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      {
        lifecycleRevision: "worker-original-revision",
        sessionId: SESSION_ID,
        updatedAt: 10,
      },
    );
    sessionTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    ADMITTED_OWNER = {
      identity: IDENTITY,
      sessionTarget: { ...sessionTarget, expectedLifecycleRevision: "worker-original-revision" },
      assertCurrent: () => undefined,
    };
    const database = openOpenClawStateDatabase();
    stateDatabasePath = database.path;
    ledgerStore = createWorkerTranscriptCommitStore({ database });
    committer = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: ledgerStore,
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    clearRuntimeConfigSnapshot();
    try {
      await waitForSessionTranscriptIndexReconcilesInStateDir(root);
      await closeOpenClawAgentDatabasesAsync(root);
      await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("commits through an alias of the admitted transcript database", async () => {
    const aliasRoot = `${root}-alias`;
    await fs.symlink(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    try {
      const aliasStorePath = path.join(aliasRoot, path.relative(root, storePath));
      const aliasTarget = await resolveSessionTranscriptRuntimeTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath: aliasStorePath,
      });
      expect(aliasTarget.storePath).toBe(aliasStorePath);

      const outcome = await committer.commit({
        ...ADMITTED_OWNER,
        sessionTarget: {
          ...aliasTarget,
          expectedLifecycleRevision: "worker-original-revision",
        },
        request: createRequest({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Persist through the admitted owner" }],
              timestamp: 100,
            },
          ],
        }),
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(`expected aliased transcript commit, received ${outcome.reason}`);
      }
      expect((await SessionManager.openAsync(sessionTarget)).getEntries()).toEqual([
        expect.objectContaining({
          id: outcome.result.newLeafId,
          message: expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Persist through the admitted owner" }],
          }),
        }),
      ]);
    } finally {
      await fs.rm(aliasRoot, { force: true });
    }
  });

  it("commits a global session for an explicitly selected agent", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const workStorePath = path.join(root, "agents", "work", "sessions", "sessions.json");
    cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: {
        scope: "global",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "work", sessionKey: "global", storePath: workStorePath },
      { sessionId: SESSION_ID, updatedAt: 20 },
    );
    const workTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "work",
      sessionId: SESSION_ID,
      sessionKey: "global",
      storePath: workStorePath,
    });
    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      sessionTarget: workTarget,
      request: createRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Persist in the owning agent" }],
            timestamp: 100,
          },
        ],
      }),
    });

    expect(outcome.ok, "WORKER_OWNER_COMMIT_139216").toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected global transcript commit, received ${outcome.reason}`);
    }
    expect((await SessionManager.openAsync(workTarget)).getEntries()).toEqual([
      expect.objectContaining({
        id: outcome.result.newLeafId,
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Persist in the owning agent" }],
        }),
      }),
    ]);
    expect((await SessionManager.openAsync(sessionTarget)).getEntries()).toEqual([]);
    expect(updates).toEqual([
      expect.objectContaining({
        agentId: "work",
        sessionId: SESSION_ID,
        sessionKey: "global",
        messageId: outcome.result.newLeafId,
      }),
    ]);
  });

  it("preserves a tool-result suffix after an already persisted prefix despite logging patterns", async () => {
    const prefixMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Already persisted worker input" }],
      timestamp: 50,
    };
    const request = createRequest({
      messages: [prefixMessage, ...createTurnMessages()],
    });
    const manager = await SessionManager.openAsync(sessionTarget);
    const persistedMessage: Parameters<SessionManager["appendMessage"]>[0] & {
      idempotencyKey: string;
    } = {
      ...prefixMessage,
      idempotencyKey: messageIdempotencyKey(request.seq, 0),
    };
    await manager.appendMessageAsync(persistedMessage);
    const entriesBefore = structuredClone(manager.getEntries());
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    cfg = { ...cfg, logging: { redactPatterns: ["^toolResult$"] } };

    const outcome = await committer.commit({ ...ADMITTED_OWNER, request });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected tool-result suffix commit, received ${outcome.reason}`);
    }

    const reopened = await SessionManager.openAsync(sessionTarget);
    const entries = reopened.getEntries();
    expect(entries.slice(0, entriesBefore.length)).toEqual(entriesBefore);
    expect(entries).toHaveLength(request.messages.length);
    expect(reopened.getLeafId()).toBe(outcome.result.newLeafId);
    expect(reopened.getLeafEntry()).toMatchObject({
      message: { role: "toolResult", content: [{ type: "text", text: "Workspace ready." }] },
    });
    expect(updates).toHaveLength(request.messages.length - entriesBefore.length);
  });

  it("admits an overlapping agent input without invalidating the active worker transcript", async () => {
    setRuntimeConfigSnapshot(cfg);
    const admit = (runId: string, text: string) =>
      prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: { message: text, idempotencyKey: runId },
        cfg,
        resolvedSessionKey: SESSION_KEY,
        admittedSessionId: SESSION_ID,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: text,
        effectiveTranscriptInputText: text,
        images: [],
        offloadedRefs: [],
        runId,
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
      });

    const first = await admit(IDENTITY.runId!, "First input");
    const firstUser = await (first.recorder?.withPendingInput
      ? first.recorder.withPendingInput(() => first.recorder!.persistApproved())
      : first.recorder?.persistApproved());
    if (!firstUser) {
      throw new Error("expected the active worker's canonical user input");
    }

    // Admission happens before the next turn can take the session lane. It must
    // not move the active worker's base while that worker is still producing output.
    const second = await admit("next-worker-run", "Second input");
    const completed = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: firstUser.messageId,
        messages: createTurnMessages().slice(1),
      }),
    });
    if (!completed.ok) {
      throw new Error(`active worker commit rejected: ${completed.reason}`);
    }

    const secondUser = await (second.recorder?.withPendingInput
      ? second.recorder.withPendingInput(() => second.recorder!.persistApproved())
      : second.recorder?.persistApproved());
    expect(secondUser).toBeDefined();
    const branch = (await SessionManager.openAsync(sessionTarget)).getBranch();
    expect(branch.map((entry) => [entry.id, entry.parentId])).toEqual([
      [firstUser.messageId, null],
      [completed.result.entryIds[0], firstUser.messageId],
      [completed.result.entryIds[1], completed.result.entryIds[0]],
      [secondUser?.messageId, completed.result.newLeafId],
    ]);
    expect(
      branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
      ),
    ).toEqual(["First input", "Second input"]);
    first.recorder?.finishPendingInput?.("interrupted");
    second.recorder?.finishPendingInput?.("interrupted");
  });

  it("rejects a commit when lifecycle ownership changes in the writer queue", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    const { promise: ownerChangeGate, resolve: releaseOwnerChange } = createDeferred();
    const { promise: ownerChangeStarted, resolve: markOwnerChangeStarted } = createDeferred();
    const ownerChange = updateSessionEntry(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "worker-replacement-revision" };
      },
    );
    await ownerChangeStarted;

    const commit = committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseOwnerChange();

    await ownerChange;
    await expect(commit).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath })).toMatchObject(
      {
        lifecycleRevision: "worker-replacement-revision",
        sessionId: SESSION_ID,
      },
    );
    expect((await SessionManager.openAsync(sessionTarget)).getEntries()).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("replays the same tuple without duplicates and rejects a changed payload", async () => {
    const request = createRequest();
    const first = await committer.commit({ ...ADMITTED_OWNER, request });
    const replay = await committer.commit({
      ...ADMITTED_OWNER,
      request: structuredClone(request),
    });
    const changed = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({ messages: createTurnMessages("Changed payload") }),
    });

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(changed).toEqual({ ok: false, reason: "invalid-batch" });
    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(3);
    if (first.ok) {
      expect(reopened.getLeafId()).toBe(first.result.newLeafId);
    }
  });

  it("recovers an interrupted terminal write after later transcript activity", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    const interruptedCommitter = createInterruptedCommitter(
      () => cfg,
      ledgerStore,
      "simulated commit-result interruption",
    );
    const request = createRequest();
    expectDefined(
      request.messages.find((message) => message.role === "assistant"),
      "assistant occurrence",
    ).itemId = "worker-assistant-recovered";

    await expect(interruptedCommitter.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
      "simulated commit-result interruption",
    );
    const afterInterruption = await SessionManager.openAsync(sessionTarget);
    const committedEntryIds = afterInterruption.getEntries().map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    const laterLeafId = await afterInterruption.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "Later local activity" }],
      timestamp: 400,
    });
    updates.length = 0;

    const replay = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(request.messages.length + 1);
    expect(reopened.getLeafId()).toBe(laterLeafId);
    expect(updates).toEqual([
      expect.objectContaining({
        assistantItemIds: ["worker-assistant-recovered"],
        message: expect.objectContaining({ idempotencyKey: messageIdempotencyKey(1, 1) }),
        messageId: committedEntryIds[1],
        messageSeq: 2,
      }),
    ]);
    await expect(committer.commit({ ...ADMITTED_OWNER, request })).resolves.toEqual(replay);
    expect(updates).toHaveLength(1);
  });

  it("replays an interrupted terminal write after its branch is abandoned", async () => {
    cfg = { ...cfg };
    const initialManager = await SessionManager.openAsync(sessionTarget);
    const baseLeafId = expectDefined(
      await initialManager.appendMessageAsync({
        role: "user",
        content: [{ type: "text", text: "Local base" }],
        timestamp: 50,
      }),
      "Expected the fixture's persisted base message",
    );
    const interruptedCommitter = createInterruptedCommitter(
      () => cfg,
      ledgerStore,
      "simulated off-branch terminal interruption",
    );
    const request = createRequest({
      baseLeafId,
      messages: createTurnMessages("my key is sk-abcdef1234567890xyz"),
    });
    expectDefined(
      request.messages.find((message) => message.role === "assistant"),
      "assistant occurrence",
    ).itemId = "worker-assistant-abandoned";

    await expect(interruptedCommitter.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
      "simulated off-branch terminal interruption",
    );
    const afterInterruption = await SessionManager.openAsync(sessionTarget);
    const committedEntries = afterInterruption
      .getEntries()
      .filter((entry) => entry.id !== baseLeafId);
    const committedEntryIds = committedEntries.map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    expect(committedEntries[0]).toMatchObject({
      message: { content: request.messages[0]?.content },
    });

    const firstCommitted = committedEntries[0];
    if (firstCommitted?.type !== "message") {
      throw new Error("expected committed worker message");
    }
    await afterInterruption.branchAsync(baseLeafId);
    const duplicatePrefixId = await afterInterruption.appendMessageAsync(
      requireAppendableWorkerMessage(firstCommitted.message),
      { idempotencyLookup: "caller-checked" },
    );
    await afterInterruption.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "Incomplete duplicate branch" }],
      timestamp: 350,
    });
    await afterInterruption.branchAsync(baseLeafId);
    const localLeafId = await afterInterruption.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "Local branch wins" }],
      timestamp: 400,
    });
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const offPublic = onSessionTranscriptUpdate((update) => updates.push(update));
    const offInternal = onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update));
    unsubscribe = () => {
      offPublic();
      offInternal();
    };
    const entriesBeforeReplay = structuredClone(afterInterruption.getEntries());
    const sessionEntryBeforeReplay = structuredClone(
      loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath }),
    );
    cfg = {
      ...cfg,
      logging: { redactPatterns: ["^user$", "^assistant$", "^toolResult$"] },
    };

    let recovered = false;
    const begin = ledgerStore.begin.bind(ledgerStore);
    const beginSpy = vi.spyOn(ledgerStore, "begin").mockImplementationOnce(async (...args) => {
      const result = await begin(...args);
      recovered = result.kind === "recover";
      return result;
    });
    await expect(
      committer.commit({
        identity: IDENTITY,
        sessionTarget,
        request,
        assertCurrent: () => {
          if (recovered) {
            throw new Error("claim closed before pending batch recovery");
          }
        },
      }),
    ).rejects.toThrow("claim closed before pending batch recovery");
    expect(recovered).toBe(true);
    beginSpy.mockRestore();

    const replay = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getEntries()).toEqual(entriesBeforeReplay);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([baseLeafId, localLeafId]);
    expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath })).toEqual(
      sessionEntryBeforeReplay,
    );
    if (!replay.ok) {
      throw new Error(`expected interrupted commit replay, received ${replay.reason}`);
    }
    expect(replay.result.entryIds).not.toContain(duplicatePrefixId);
    expect(updates).toEqual([]);
    expect(internalUpdates).toEqual([]);
  });

  it("rolls back the entire transcript batch when commit authority is revoked", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptScope(sessionTarget)),
    );
    let current = true;
    let refusedCommit = false;
    const admission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (
        request.stage === "commit" &&
        isRecord(request.facts) &&
        isRecord(request.facts.identity) &&
        request.facts.identity.nativeLocation === databasePath
      ) {
        refusedCommit = true;
        current = false;
      }
      admit(request, grant);
    });
    const updates: InternalSessionTranscriptUpdate[] = [];
    unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    const request = createRequest();
    const entryBeforeFailure = loadSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath,
    });

    try {
      await expect(
        committer.commit({
          ...ADMITTED_OWNER,
          request,
          assertCurrent: () => {
            if (!current) {
              throw new Error("Worker turn owner retired at batch commit");
            }
          },
        }),
      ).rejects.toThrow("Worker turn owner retired at batch commit");
      expect(refusedCommit).toBe(true);
    } finally {
      admission.mockRestore();
      current = true;
    }
    expect(updates).toEqual([]);
    expect((await SessionManager.openAsync(sessionTarget)).getEntries()).toEqual([]);
    const entryAfterFailure = loadSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath,
    });
    expect(entryAfterFailure).toEqual(entryBeforeFailure);

    const manager = await SessionManager.openAsync(sessionTarget);
    const localLeafId = await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "Local activity after interruption" }],
      timestamp: 400,
    });
    const retry = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(retry).toEqual({ ok: false, reason: "stale-base-leaf" });
    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getEntries()).toEqual([
      expect.objectContaining({
        id: localLeafId,
        message: expect.objectContaining({ role: "user" }),
      }),
    ]);
  });

  it("does not reuse an idempotency key from an abandoned transcript branch", async () => {
    const first = await committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    if (!first.ok) {
      throw new Error(`expected initial transcript commit success, received ${first.reason}`);
    }
    const manager = await SessionManager.openAsync(sessionTarget);
    const abandonedMessage: Parameters<SessionManager["appendMessage"]>[0] & {
      idempotencyKey: string;
    } = {
      role: "user",
      content: [{ type: "text", text: "Abandoned worker-shaped row" }],
      timestamp: 400,
      idempotencyKey: messageIdempotencyKey(2, 0),
    };
    const abandonedId = await manager.appendMessageAsync(abandonedMessage);
    await manager.branchAsync(first.result.newLeafId);
    const activeLeafId = await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "Active local row" }],
      timestamp: 500,
    });

    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: activeLeafId,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Fresh worker row" }],
            timestamp: 600,
          },
        ],
        seq: 2,
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected branch-safe transcript commit, received ${outcome.reason}`);
    }
    expect(outcome.result.newLeafId).not.toBe(abandonedId);
    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getLeafId()).toBe(outcome.result.newLeafId);
    expect(reopened.getEntry(outcome.result.newLeafId)).toMatchObject({
      parentId: activeLeafId,
      message: expect.objectContaining({ idempotencyKey: messageIdempotencyKey(2, 0) }),
    });
  });

  it("persists run and delivery facts while only the terminal envelope completes it", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const offPublic = unsubscribe;
    const offInternal = onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update));
    unsubscribe = () => {
      offPublic();
      offInternal();
    };
    const literalUserText = "Keep [[reply_to_current]] as user text";
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: createNoisyPngBuffer(256, 256).toString("base64"),
    };
    expect(Buffer.byteLength(image.data)).toBeGreaterThan(64 * 1024);
    const messages = createTurnMessages(literalUserText);
    expectDefined(
      messages.find((message) => message.role === "assistant"),
      "assistant occurrence",
    ).itemId = "worker-assistant-occurrence";
    const toolResult = messages[2]!;
    if (toolResult.role !== "toolResult") {
      throw new Error("missing read result");
    }
    toolResult.content.push(image);
    const first = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({ messages }),
    });
    if (!first.ok) {
      throw new Error(`expected initial transcript commit success, received ${first.reason}`);
    }
    const nextMessage: WorkerTranscriptMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "[[reply_to:message-7]][[audio_as_voice]][[tts:provider=mock voiceId=voice-7]]Finished.[[tts:text]]Spoken answer[[/tts:text]]",
        },
        { type: "text", text: "Use `[[reply_to_current]]` literally." },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: 400,
    };

    const secondRequest = createRequest({
      baseLeafId: first.result.newLeafId,
      messages: [nextMessage],
      seq: 2,
    });
    const originalRequest = structuredClone(secondRequest);
    const second = await committer.commit({ ...ADMITTED_OWNER, request: secondRequest });
    await expect(committer.commit({ ...ADMITTED_OWNER, request: secondRequest })).resolves.toEqual(
      second,
    );
    expect(secondRequest).toEqual(originalRequest);

    if (!second.ok) {
      throw new Error(`expected sequential transcript commit success, received ${second.reason}`);
    }
    expect(second.result.entryIds).toEqual([second.result.newLeafId]);
    expect(second.result.newLeafId).not.toBe(first.result.newLeafId);
    const reopened = await SessionManager.openAsync(sessionTarget);
    const deliveredMessage = {
      role: "assistant",
      __openclaw: { runId: IDENTITY.runId },
      content: [
        { type: "text", text: "Finished." },
        { type: "text", text: "Use `[[reply_to_current]]` literally." },
      ],
      openclawDelivery: {
        audioAsVoice: true,
        replyToId: "message-7",
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "mock", values: { voiceid: "voice-7" } }],
        },
      },
    };
    expect(reopened.getEntries()).toMatchObject([
      { message: { role: "user", content: [{ type: "text", text: literalUserText }] } },
      {
        message: {
          role: "assistant",
          __openclaw: { runId: IDENTITY.runId },
          providerReplay: PROVIDER_REPLAY,
        },
      },
      {
        message: {
          role: "toolResult",
          __openclaw: { runId: IDENTITY.runId },
          content: expect.arrayContaining([image]),
        },
      },
      { id: second.result.newLeafId, parentId: first.result.newLeafId, message: deliveredMessage },
    ]);
    expect(reopened.getEntries()[0]).not.toHaveProperty("message.openclawDelivery");
    expect(reopened.getLeafId()).toBe(second.result.newLeafId);
    expect(updates).toHaveLength(4);
    for (const update of updates.slice(0, 3)) {
      expect(update).not.toHaveProperty("runId");
    }
    expect(updates[3]).toMatchObject({
      message: deliveredMessage,
      messageId: second.result.newLeafId,
      messageSeq: 4,
      runId: IDENTITY.runId,
    });
    expect(updates[0]?.message).not.toHaveProperty("openclawDelivery");
    expect(updates[1]?.message).not.toHaveProperty("providerReplay");
    expect(updates[1]?.message).not.toHaveProperty("itemId");
    expect(updates[1]).not.toHaveProperty("assistantItemIds");
    expect(reopened.getEntries()[1]).not.toHaveProperty("message.itemId");
    expect(internalUpdates[1]).toMatchObject({
      assistantItemIds: ["worker-assistant-occurrence"],
      message: { idempotencyKey: messageIdempotencyKey(1, 1) },
      messageId: first.result.entryIds[1],
      messageSeq: 2,
    });
    expect(updates[1]).not.toHaveProperty("lifecycleRevision");
    expect(internalUpdates.map((update) => update.lifecycleRevision)).toEqual(
      updates.map(() => "worker-original-revision"),
    );
  });

  it("commits and replays hidden system context without changing provenance", async () => {
    const identity = IDENTITY;
    const message = createTurnMessages()[0]!;
    if (message.role !== "user") {
      throw new Error("expected a user input");
    }
    const updates: InternalSessionTranscriptUpdate[] = [];
    unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    const text = "Sender: <operator>\nActive exec sessions: none";
    const carrier = buildRuntimeContextCustomMessage(
      text,
      [{ kind: "conversation-data", text }],
      true,
    );
    if (!Value.Check(WorkerTranscriptMessageSchema, carrier)) {
      throw new Error("Worker schema rejected the runtime-owned context message");
    }
    const request = { runEpoch: 7, seq: 1, baseLeafId: null, messages: [message, carrier] };
    expect(Value.Check(WorkerTranscriptCommitParamsSchema, request)).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitParamsSchema, {
        ...request,
        messages: [{ ...carrier, customType: "unrelated-extension-context" }],
      }),
    ).toBe(false);

    const input = { identity, sessionTarget, request, assertCurrent: () => undefined };
    const runtime = createWorkerTranscriptRuntime({
      commit: async (messages) => {
        await expect(
          committer.commit({ ...input, request: { ...request, messages } }),
        ).resolves.toMatchObject({ ok: true });
      },
    });
    runtime.onMessagePersisted(message);
    runtime.onMessagePersisted(carrier);
    await runtime.withSessionWriteSettlement(() => undefined);
    await expect(committer.commit(input)).resolves.toMatchObject({ ok: true });

    const reopened = await SessionManager.openAsync(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(2);
    expect(reopened.buildSessionContext().messages[0]).toMatchObject(message);
    expect(reopened.buildSessionContext().messages[1]).toEqual({
      ...carrier,
      display: false,
      idempotencyKey: expect.any(String),
    });
    expect(updates.map((update) => update.lifecycleRevision)).toEqual([
      "worker-original-revision",
      "worker-original-revision",
    ]);
  });

  it.each([false, true])(
    "pins an unbound transcript lifecycle through preparation (replacement: %s)",
    async (replaceLifecycle) => {
      const message = createTurnMessages()[0]!;
      if (message.role !== "user") {
        throw new Error("expected a user input");
      }
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
      expect(prepared.result).toMatchObject({
        ok: true,
        lifecycleRevision: "worker-original-revision",
      });
      if (replaceLifecycle) {
        await updateSessionEntry(sessionTarget, () => ({ lifecycleRevision: "replacement" }));
      }
      const outcome = await withTranscriptWriteTransaction(sessionTarget, () =>
        applyPreparedTranscriptCommit(input, prepared, input.messages, () => undefined),
      );
      expect(outcome).toMatchObject(
        replaceLifecycle
          ? { ok: false, reason: "invalid-batch" }
          : { ok: true, lifecycleRevision: "worker-original-revision" },
      );
      const entries = (await SessionManager.openAsync(sessionTarget)).getEntries();
      expect(entries).toHaveLength(replaceLifecycle ? 0 : 1);
      if (!replaceLifecycle) {
        expect(entries[0]).toMatchObject({
          type: "message",
          message: { content: [{ type: "text", text: "Inspect the workspace" }] },
        });
      }
    },
  );

  it("releases an unused transcript reservation when its authority closes", async () => {
    const identity = IDENTITY;
    const message = createTurnMessages()[0]!;
    if (message.role !== "user") {
      throw new Error("expected a user input");
    }
    let current = true;
    const begin = ledgerStore.begin.bind(ledgerStore);
    vi.spyOn(ledgerStore, "begin").mockImplementationOnce(async (...args) => {
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
});
