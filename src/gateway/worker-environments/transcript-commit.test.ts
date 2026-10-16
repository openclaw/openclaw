import fs from "node:fs/promises";
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
} from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createWorkerTranscriptRuntime } from "../../worker/embedded-agent-transcript.runtime.js";
import { prepareAgentRunUserTurn } from "../agent-turn/agent-run-user-turn.js";
import type { AgentTurnContext } from "../agent-turn/types.js";
import {
  createTranscriptCommitFixture,
  IDENTITY,
  SESSION_KEY,
} from "./transcript-commit.fixture.test-support.js";
import type { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  applyPreparedTranscriptCommit,
  prepareTranscriptCommit,
} from "./transcript-commit.kernel.js";
import {
  createInterruptedCommitter,
  createRequest,
  createTurnMessages,
  messageIdempotencyKey,
  PROVIDER_REPLAY,
  SESSION_ID,
  ZERO_USAGE,
} from "./transcript-commit.test-support.js";
import type { TranscriptCommitInput } from "./transcript-commit.types.js";

type WorkerTranscriptCommitter = ReturnType<typeof createWorkerTranscriptCommitter>;
type CommitOwner = Omit<Parameters<WorkerTranscriptCommitter["commit"]>[0], "request">;

function userMessage(text: string, timestamp = 100) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function requireSuccess(outcome: Awaited<ReturnType<WorkerTranscriptCommitter["commit"]>>) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error(`expected transcript commit, received ${outcome.reason}`);
  }
  return outcome;
}

function messageEntry(message: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return expect.objectContaining({ ...fields, message: expect.objectContaining(message) });
}

function assertAuthority(isCurrent: () => boolean, message: string) {
  return () => {
    if (!isCurrent()) {
      throw new Error(message);
    }
    return undefined;
  };
}

describe("worker transcript commit application", () => {
  let fixture: Awaited<ReturnType<typeof createTranscriptCommitFixture>>;
  let cfg: OpenClawConfig;
  let unsubscribe: (() => void) | undefined;

  const commit = (request = createRequest(), owner: Partial<CommitOwner> = {}) =>
    fixture.committer.commit({ ...fixture.owner, ...owner, request });
  const commitOk = async (
    params: Parameters<typeof createRequest>[0] = {},
    owner: Partial<CommitOwner> = {},
  ) => requireSuccess(await commit(createRequest(params), owner));
  const openSession = () => SessionManager.openAsync(fixture.sessionTarget);
  const readEntry = () => loadSessionEntry(fixture.sessionTarget);
  const interrupt = (request: ReturnType<typeof createRequest>, message: string) =>
    expect(
      createInterruptedCommitter(() => cfg, fixture.ledgerStore, message).commit({
        ...fixture.owner,
        request,
      }),
    ).rejects.toThrow(message);
  const listen = () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    return updates;
  };
  const listenBoth = () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const offPublic = onSessionTranscriptUpdate((update) => updates.push(update));
    const offInternal = onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update));
    unsubscribe = () => {
      offPublic();
      offInternal();
    };
    return { updates, internalUpdates };
  };

  let close: Awaited<ReturnType<typeof createTranscriptCommitFixture>>["close"] | undefined;

  beforeEach(async () => {
    close = undefined;
    fixture = await createTranscriptCommitFixture(() => cfg);
    cfg = fixture.cfg;
    close = fixture.close;
  });

  afterEach(async () => {
    unsubscribe?.();
    clearRuntimeConfigSnapshot();
    await close?.();
  });

  it("commits through an admitted database alias without invalidating retained tool policy", async () => {
    const entry = loadSessionEntry(fixture.sessionTarget);
    const databasePath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptScope(fixture.sessionTarget)),
    );
    const retained = retainPreparedSessionEntryPredicate({
      databaseIdentity: readDatabasePathIdentitySync(databasePath).key,
      sessionKey: SESSION_KEY,
      entry,
      matches: (before, after) =>
        before?.sessionId === after?.sessionId &&
        before?.lifecycleRevision === after?.lifecycleRevision &&
        before?.sandboxMode === after?.sandboxMode,
    });
    const aliasRoot = `${fixture.root}-alias`;
    await fs.symlink(fixture.root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    try {
      const aliasStorePath = path.join(aliasRoot, path.relative(fixture.root, fixture.storePath));
      const aliasTarget = await resolveSessionTranscriptRuntimeTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath: aliasStorePath,
      });
      expect(aliasTarget.storePath).toBe(aliasStorePath);

      const outcome = await commitOk(
        { messages: [userMessage("Persist through the admitted owner")] },
        {
          sessionTarget: {
            ...aliasTarget,
            expectedLifecycleRevision: "worker-original-revision",
          },
        },
      );
      expect(retained.isCurrent()).toBe(true);
      expect((await openSession()).getEntries()).toEqual([
        messageEntry(
          { role: "user", content: [{ type: "text", text: "Persist through the admitted owner" }] },
          { id: outcome.result.newLeafId },
        ),
      ]);
    } finally {
      retained.release();
      await fs.rm(aliasRoot, { force: true });
    }
  });

  it("commits a global session for an explicitly selected agent", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const workStorePath = path.join(fixture.root, "agents", "work", "sessions", "sessions.json");
    cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: {
        scope: "global",
        store: path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json"),
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
    const outcome = await commitOk(
      { messages: [userMessage("Persist in the owning agent")] },
      { sessionTarget: workTarget },
    );
    expect((await SessionManager.openAsync(workTarget)).getEntries()).toEqual([
      messageEntry(
        { role: "user", content: [{ type: "text", text: "Persist in the owning agent" }] },
        { id: outcome.result.newLeafId },
      ),
    ]);
    expect((await openSession()).getEntries()).toEqual([]);
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
    const prefixMessage = userMessage("Already persisted worker input", 50);
    const request = createRequest({
      messages: [prefixMessage, ...createTurnMessages()],
    });
    const manager = await openSession();
    const persistedMessage = {
      ...prefixMessage,
      idempotencyKey: messageIdempotencyKey(request.seq, 0),
    };
    await manager.appendMessageAsync(persistedMessage);
    const entriesBefore = structuredClone(manager.getEntries());
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    cfg = { ...cfg, logging: { redactPatterns: ["^toolResult$"] } };

    const outcome = requireSuccess(await commit(request));

    const reopened = await openSession();
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
    const onUserTurnMediaPersisted = vi.fn();
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
        onUserTurnMediaPersisted,
        runId,
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
      });

    const first = await admit(IDENTITY.runId!, "First input");
    expect(onUserTurnMediaPersisted).not.toHaveBeenCalled();
    const firstUser = await (first.recorder?.withPendingInput
      ? first.recorder.withPendingInput(() => first.recorder!.persistApproved())
      : first.recorder?.persistApproved());
    if (!firstUser) {
      throw new Error("expected the active worker's canonical user input");
    }

    // Admission happens before the next turn can take the session lane. It must
    // not move the active worker's base while that worker is still producing output.
    const second = await admit("next-worker-run", "Second input");
    expect(onUserTurnMediaPersisted).not.toHaveBeenCalled();
    const completed = await commitOk({
      baseLeafId: firstUser.messageId,
      messages: createTurnMessages().slice(1),
    });

    const secondUser = await (second.recorder?.withPendingInput
      ? second.recorder.withPendingInput(() => second.recorder!.persistApproved())
      : second.recorder?.persistApproved());
    expect(secondUser).toBeDefined();
    const branch = (await openSession()).getBranch();
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
    const updates = listen();
    const { promise: ownerChangeGate, resolve: releaseOwnerChange } = createDeferred();
    const { promise: ownerChangeStarted, resolve: markOwnerChangeStarted } = createDeferred();
    const ownerChange = updateSessionEntry(
      { agentId: "main", sessionKey: SESSION_KEY, storePath: fixture.storePath },
      async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "worker-replacement-revision" };
      },
    );
    await ownerChangeStarted;

    const pendingCommit = commit();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseOwnerChange();

    await ownerChange;
    await expect(pendingCommit).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(readEntry()).toMatchObject({
      lifecycleRevision: "worker-replacement-revision",
      sessionId: SESSION_ID,
    });
    expect((await openSession()).getEntries()).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("replays the same tuple without duplicates and rejects a changed payload", async () => {
    const request = createRequest();
    const first = await commit(request);
    const replay = await commit(structuredClone(request));
    const changed = await commit(
      createRequest({ messages: createTurnMessages("Changed payload") }),
    );

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(changed).toEqual({ ok: false, reason: "invalid-batch" });
    const reopened = await openSession();
    expect(reopened.getEntries()).toHaveLength(3);
    if (first.ok) {
      expect(reopened.getLeafId()).toBe(first.result.newLeafId);
    }
  });

  it("recovers an interrupted terminal write after later transcript activity", async () => {
    const updates = listen();
    const request = createRequest();
    expectDefined(
      request.messages.find((message) => message.role === "assistant"),
      "assistant occurrence",
    ).itemId = "worker-assistant-recovered";

    await interrupt(request, "simulated commit-result interruption");
    const afterInterruption = await openSession();
    const committedEntryIds = afterInterruption.getEntries().map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    const laterLeafId = await afterInterruption.appendMessageAsync(
      userMessage("Later local activity", 400),
    );
    updates.length = 0;

    const replay = requireSuccess(await commit(request));

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = await openSession();
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
    await expect(commit(request)).resolves.toEqual(replay);
    expect(updates).toHaveLength(1);
  });

  it("replays an interrupted terminal write after its branch is abandoned", async () => {
    cfg = { ...cfg };
    const initialManager = await openSession();
    const baseLeafId = expectDefined(
      await initialManager.appendMessageAsync(userMessage("Local base", 50)),
      "Expected the fixture's persisted base message",
    );
    const request = createRequest({
      baseLeafId,
      messages: createTurnMessages("my key is sk-abcdef1234567890xyz"),
    });
    expectDefined(
      request.messages.find((message) => message.role === "assistant"),
      "assistant occurrence",
    ).itemId = "worker-assistant-abandoned";

    await interrupt(request, "simulated off-branch terminal interruption");
    const afterInterruption = await openSession();
    const committedEntries = afterInterruption
      .getEntries()
      .filter((entry) => entry.id !== baseLeafId);
    const committedEntryIds = committedEntries.map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    expect(committedEntries[0]).toMatchObject({
      message: { content: request.messages[0]?.content },
    });

    const firstCommitted = committedEntries[0];
    if (firstCommitted?.type !== "message" || firstCommitted.message.role !== "user") {
      throw new Error("expected committed worker message");
    }
    await afterInterruption.branchAsync(baseLeafId);
    const duplicatePrefixId = await afterInterruption.appendMessageAsync(firstCommitted.message, {
      idempotencyLookup: "caller-checked",
    });
    await afterInterruption.appendMessageAsync(userMessage("Incomplete duplicate branch", 350));
    await afterInterruption.branchAsync(baseLeafId);
    const localLeafId = await afterInterruption.appendMessageAsync(
      userMessage("Local branch wins", 400),
    );
    const { updates, internalUpdates } = listenBoth();
    const entriesBeforeReplay = structuredClone(afterInterruption.getEntries());
    const sessionEntryBeforeReplay = structuredClone(readEntry());
    cfg = {
      ...cfg,
      logging: { redactPatterns: ["^user$", "^assistant$", "^toolResult$"] },
    };

    let recovered = false;
    const begin = fixture.ledgerStore.begin.bind(fixture.ledgerStore);
    const beginSpy = vi
      .spyOn(fixture.ledgerStore, "begin")
      .mockImplementationOnce(async (...args) => {
        const result = await begin(...args);
        recovered = result.kind === "recover";
        return result;
      });
    await expect(
      commit(request, {
        sessionTarget: fixture.sessionTarget,
        assertCurrent: assertAuthority(
          () => !recovered,
          "claim closed before pending batch recovery",
        ),
      }),
    ).rejects.toThrow("claim closed before pending batch recovery");
    expect(recovered).toBe(true);
    beginSpy.mockRestore();

    const replay = requireSuccess(await commit(request));

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = await openSession();
    expect(reopened.getEntries()).toEqual(entriesBeforeReplay);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([baseLeafId, localLeafId]);
    expect(readEntry()).toEqual(sessionEntryBeforeReplay);
    expect(replay.result.entryIds).not.toContain(duplicatePrefixId);
    expect(updates).toEqual([]);
    expect(internalUpdates).toEqual([]);
  });

  it("rolls back the entire transcript batch when commit authority is revoked", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptScope(fixture.sessionTarget)),
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
    const updates = listen();
    const request = createRequest();
    const entryBeforeFailure = readEntry();

    try {
      await expect(
        commit(request, {
          assertCurrent: assertAuthority(
            () => current,
            "Worker turn owner retired at batch commit",
          ),
        }),
      ).rejects.toThrow("Worker turn owner retired at batch commit");
      expect(refusedCommit).toBe(true);
    } finally {
      admission.mockRestore();
      current = true;
    }
    expect(updates).toEqual([]);
    expect((await openSession()).getEntries()).toEqual([]);
    const entryAfterFailure = readEntry();
    expect(entryAfterFailure).toEqual(entryBeforeFailure);

    const manager = await openSession();
    const localLeafId = await manager.appendMessageAsync(
      userMessage("Local activity after interruption", 400),
    );
    const retry = await commit(request);

    expect(retry).toEqual({ ok: false, reason: "stale-base-leaf" });
    const reopened = await openSession();
    expect(reopened.getEntries()).toEqual([messageEntry({ role: "user" }, { id: localLeafId })]);
  });

  it("does not reuse an idempotency key from an abandoned transcript branch", async () => {
    const first = requireSuccess(await commit());
    const manager = await openSession();
    const abandonedMessage = {
      ...userMessage("Abandoned worker-shaped row", 400),
      idempotencyKey: messageIdempotencyKey(2, 0),
    };
    const abandonedId = await manager.appendMessageAsync(abandonedMessage);
    await manager.branchAsync(first.result.newLeafId);
    const activeLeafId = await manager.appendMessageAsync(userMessage("Active local row", 500));

    const outcome = await commitOk({
      baseLeafId: activeLeafId,
      messages: [userMessage("Fresh worker row", 600)],
      seq: 2,
    });
    expect(outcome.result.newLeafId).not.toBe(abandonedId);
    const reopened = await openSession();
    expect(reopened.getLeafId()).toBe(outcome.result.newLeafId);
    expect(reopened.getEntry(outcome.result.newLeafId)).toMatchObject({
      parentId: activeLeafId,
      message: expect.objectContaining({ idempotencyKey: messageIdempotencyKey(2, 0) }),
    });
  });

  it("persists run and delivery facts while only the terminal envelope completes it", async () => {
    const { updates, internalUpdates } = listenBoth();
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
    const first = await commitOk({ messages });
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
    const second = requireSuccess(await commit(secondRequest));
    await expect(commit(secondRequest)).resolves.toEqual(second);
    expect(secondRequest).toEqual(originalRequest);

    expect(second.result.entryIds).toEqual([second.result.newLeafId]);
    expect(second.result.newLeafId).not.toBe(first.result.newLeafId);
    const reopened = await openSession();
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
    const message = userMessage("Inspect the workspace");
    const updates = listen();
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

    const input = {
      identity: IDENTITY,
      sessionTarget: fixture.sessionTarget,
      request,
      assertCurrent: () => undefined,
    };
    const runtime = createWorkerTranscriptRuntime({
      commit: async (messages) => {
        await expect(
          fixture.committer.commit({ ...input, request: { ...request, messages } }),
        ).resolves.toMatchObject({ ok: true });
      },
    });
    runtime.onMessagePersisted(message);
    runtime.onMessagePersisted(carrier);
    await runtime.withSessionWriteSettlement(() => undefined);
    await expect(fixture.committer.commit(input)).resolves.toMatchObject({ ok: true });

    const reopened = await openSession();
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
      const message = userMessage("Inspect the workspace");
      const input: TranscriptCommitInput = {
        scope: fixture.sessionTarget,
        lifecycleRevision: undefined,
        requestedBaseLeafId: null,
        recoverPersistedBatch: false,
        messages: [{ ...message, idempotencyKey: "worker-unbound-lifecycle" }],
        cwd: fixture.root,
      };
      const databaseOptions = toDatabaseOptions(
        resolveSqliteTranscriptScope(fixture.sessionTarget),
      );
      const prepared = runOpenClawAgentWriteTransaction(
        () => prepareTranscriptCommit(input),
        databaseOptions,
      );
      expect(prepared.result).toMatchObject({
        ok: true,
        lifecycleRevision: "worker-original-revision",
      });
      if (replaceLifecycle) {
        await updateSessionEntry(fixture.sessionTarget, () => ({
          lifecycleRevision: "replacement",
        }));
      }
      const outcome = runOpenClawAgentWriteTransaction(
        () => applyPreparedTranscriptCommit(input, prepared, input.messages, () => undefined),
        databaseOptions,
      );
      expect(outcome).toMatchObject(
        replaceLifecycle
          ? { ok: false, reason: "invalid-batch" }
          : { ok: true, lifecycleRevision: "worker-original-revision" },
      );
      const entries = (await openSession()).getEntries();
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
    const message = userMessage("Inspect the workspace");
    let current = true;
    const begin = fixture.ledgerStore.begin.bind(fixture.ledgerStore);
    vi.spyOn(fixture.ledgerStore, "begin").mockImplementationOnce(async (...args) => {
      const result = await begin(...args);
      current = false;
      return result;
    });
    const request = { runEpoch: 7, seq: 1, baseLeafId: null, messages: [message] };
    await expect(
      commit(request, {
        sessionTarget: fixture.sessionTarget,
        assertCurrent: assertAuthority(() => current, "Worker owner closed after reservation"),
      }),
    ).rejects.toThrow("Worker owner closed after reservation");
    expect((await openSession()).getEntries()).toEqual([]);
    await expect(
      commit(
        {
          ...request,
          messages: [userMessage("Fresh request after cancellation", 101)],
        },
        { sessionTarget: fixture.sessionTarget },
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});
