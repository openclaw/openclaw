import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as sessionUtils from "../session-utils.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import {
  captureAbortedPartial,
  prepareChatAbortSessionSnapshot,
  persistAbortedPartials,
} from "./chat-transcript-persistence.runtime.js";
import {
  collectMessagesWithIdempotencyKey,
  findMessageWithIdempotencyKey,
  collectAssistantRowsWithText,
  expectRecord,
  expectAbortPayload,
  expectAbortPayloadContainsRunIds,
  requireLastRespondCall,
  expectPersistedAbortMessage,
  type TranscriptLine,
} from "./chat.abort-persistence.test-helpers.js";
import {
  createAbortTestRunState,
  createActiveRun as createUnscopedRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  storePath: "",
  sessionId: "",
  hasEntry: true,
  lifecycleRevision: undefined as string | undefined,
  canonicalKey: "main",
  cfg: {} as Record<string, unknown>,
}));

function createActiveRun(...[sessionKey, options]: Parameters<typeof createUnscopedRun>) {
  return createUnscopedRun(sessionKey, {
    ...(sessionKey === "main" ? { agentId: "main" } : {}),
    storeScope: sessionEntryState.storePath || "/synthetic/chat-abort-persistence/sessions.db",
    ...options,
  });
}

function loadAbortSessionFixture(opts?: { agentId?: string }) {
  return {
    cfg: sessionEntryState.cfg,
    agentId: opts?.agentId ?? "main",
    storePath: sessionEntryState.storePath,
    entry: sessionEntryState.hasEntry
      ? {
          sessionId: sessionEntryState.sessionId,
          lifecycleRevision: sessionEntryState.lifecycleRevision,
          sessionFile: sessionEntryState.transcriptPath,
        }
      : undefined,
    canonicalKey: sessionEntryState.canonicalKey,
  };
}

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
      loadAbortSessionFixture({ agentId: params.agentId }),
  };
});

const { handleDirectExternalChatSend } = await import("./chat-send-external-entry.js");

type AbortOptions = Parameters<typeof invokeChatAbortHandler>[0];

function expectAborted(respond: ReturnType<typeof vi.fn>, runIds: string[]) {
  const [ok, payload] = requireLastRespondCall(respond);
  expect(ok).toBe(true);
  expectAbortPayload(payload, { runIds });
}

function expectPartial(message: unknown, runId: string, stopReason?: string) {
  expectPersistedAbortMessage(message, {
    idempotencyKey: `${runId}:assistant`,
    origin: "rpc",
    runId,
    ...(stopReason ? { stopReason } : {}),
  });
}

function abort(
  context: AbortOptions["context"],
  request: AbortOptions["request"],
  respond = vi.fn(),
  client?: AbortOptions["client"],
) {
  return invokeChatAbortHandler({
    handler: handleChatAbortRequest,
    context,
    request,
    respond,
    client,
  });
}

async function stop(
  context: AbortOptions["context"],
  params: Omit<
    Parameters<typeof handleDirectExternalChatSend>[0]["params"],
    "message" | "idempotencyKey"
  >,
) {
  const respond = vi.fn();
  await handleDirectExternalChatSend({
    params: { message: "stop", idempotencyKey: "stop", ...params },
    respond,
    context: context as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function globalConfig() {
  return createCanonicalAgentConfigFixture({
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { scope: "global" },
  }).config;
}

function globalRuns(selectedAgentId?: string, sessionId?: string) {
  const run = (agentId: string) =>
    createActiveRun("global", {
      sessionId: selectedAgentId === agentId ? sessionId : `sess-${agentId}-global`,
      agentId,
    });
  const mainActive = run("main");
  const workActive = run("work");
  return {
    mainActive,
    workActive,
    sources: [
      ["run-main-global", mainActive],
      ["run-work-global", workActive],
    ] as const,
  };
}

function bufferedContext(
  sessionId: string,
  runs: Array<[runId: string, buffer: string, options?: Parameters<typeof createActiveRun>[1]]>,
  overrides: Parameters<typeof createChatAbortContext>[0] = {},
) {
  return createChatAbortContext({
    sources: new Map(
      runs.map(([runId, , options]) => [runId, createActiveRun("main", { sessionId, ...options })]),
    ),
    chatRunState: createAbortTestRunState(
      runs.map(([runId, buffer]) => [runId, { buffer, deltaSentAt: Date.now() }]),
    ),
    ...overrides,
  });
}

async function partialSnapshot(
  params: Omit<Parameters<typeof captureAbortedPartial>[0], "session" | "sessionKey">,
) {
  return captureAbortedPartial({
    session: await prepareChatAbortSessionSnapshot({
      cfg: sessionEntryState.cfg,
      key: "main",
      agentId: "main",
    }),
    sessionKey: "main",
    ...params,
  });
}

function persistPartial(snapshot: Awaited<ReturnType<typeof partialSnapshot>>, warn = vi.fn()) {
  return persistAbortedPartials({ context: { logGateway: { warn } }, snapshots: [snapshot] });
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-chat-abort-");

function setMockSessionEntry(params: {
  sessionId: string;
  storePath: string;
  transcriptPath: string;
  hasEntry?: boolean;
}) {
  sessionEntryState.transcriptPath = params.transcriptPath;
  sessionEntryState.storePath = params.storePath || "/synthetic/chat-abort-persistence/sessions.db";
  sessionEntryState.sessionId = params.sessionId;
  sessionEntryState.hasEntry = params.hasEntry ?? true;
  sessionEntryState.lifecycleRevision = undefined;
  sessionEntryState.canonicalKey = "agent:main:main";
  sessionEntryState.cfg = {};
}

async function createTranscriptFixture(
  owner = { agentId: "main", sessionKey: "main" },
  { sessionId = "sess-main", hasEntry = true } = {},
) {
  const dir = sessionDirs.make();
  const storePath = path.join(dir, "sessions.json");
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: owner.agentId,
    sessionId,
    storePath,
  });
  const writeEntry = (entry: Partial<Parameters<typeof replaceSessionEntry>[1]>) =>
    replaceSessionEntry({ ...owner, storePath }, { sessionId, updatedAt: Date.now(), ...entry });
  if (hasEntry) {
    await writeEntry({ sessionFile: transcriptPath });
  }
  setMockSessionEntry({ transcriptPath, storePath, sessionId, hasEntry });
  return {
    sessionId,
    storePath,
    writeEntry,
    readTranscript: async () =>
      (await loadTranscriptEvents({ ...owner, sessionId, storePath })) as TranscriptLine[],
  };
}

function appendTranscriptMessage(
  { sessionId, storePath }: { sessionId: string; storePath: string },
  message: Record<string, unknown>,
) {
  const seeded = appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionId,
      sessionKey: "main",
      storePath,
    },
    {
      idempotencyLookup: "caller-checked",
      message,
      now: 1,
    },
  );
  expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
}

function seedCommittedReply(params: { sessionId: string; storePath: string; runId?: string }) {
  appendTranscriptMessage(params, {
    role: "assistant",
    content: [{ type: "text", text: "Completed reply" }],
    timestamp: Date.now(),
    stopReason: "stop",
    ...(params.runId ? { __openclaw: { runId: params.runId } } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentEventsForTest();
});

describe("chat abort transcript persistence", () => {
  it("commits an already-cancelled parent partial when revocation fences later worker cancellation", async () => {
    const { readTranscript, sessionId, storePath, writeEntry } = await createTranscriptFixture();
    const revision = "original-generation";
    await writeEntry({ lifecycleRevision: revision, updatedAt: 1 });
    sessionEntryState.lifecycleRevision = revision;
    let current = true;
    const parent = createActiveRun("main", { sessionId });
    parent.input.abortSignal.addEventListener(
      "abort",
      () => {
        current = false;
      },
      { once: true },
    );
    const cancelWorker = vi.fn(() => ["parent"]);
    const context = createChatAbortContext({
      sources: [["parent", parent]],
      workerEnvironmentService: createWorkerInferenceCancellationService(
        sessionId,
        ["parent"],
        cancelWorker,
      ),
    });
    context.chatRunState.getOrCreate("parent").buffer = "Keep the cancelled parent partial";
    await expect(
      invokeChatAbortHandler({
        handler: (options) =>
          handleChatAbortRequest({ ...options, hasCurrentClientAuthority: () => current }),
        context,
        request: { sessionKey: "main" },
        client: { connect: { scopes: ["operator.admin"] } },
      }),
    ).rejects.toMatchObject({
      message: "Chat cancellation and persistence failed",
      errors: [
        expect.objectContaining({ message: "Gateway requester authority changed" }),
        expect.objectContaining({ message: "Gateway requester authority changed" }),
      ],
    });
    expect(parent.input.abortSignal.aborted).toBe(true);
    expect(cancelWorker).not.toHaveBeenCalled();
    const lines = await readTranscript();
    const committed = collectMessagesWithIdempotencyKey(lines, "parent:assistant");
    expect(committed).toHaveLength(1);
    expectPartial(committed[0], "parent");
    expect(collectAssistantRowsWithText(lines, "Keep the cancelled parent partial")).toHaveLength(
      1,
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: "main", storePath })).toMatchObject({
      sessionId,
      lifecycleRevision: revision,
    });
  });

  it.each([
    { origin: "placement-abandon" as const, rejects: true },
    { origin: "rpc" as const, rejects: false },
  ])("keeps $origin append failure at its owning abort boundary", async ({ origin, rejects }) => {
    const { sessionId } = await createTranscriptFixture();
    sessionEntryState.storePath = "";
    const warn = vi.fn();
    const persistence = persistPartial(
      await partialSnapshot({
        sessionId,
        runId: "failed-abort-run",
        text: "partial that cannot be persisted",
        abortOrigin: origin,
      }),
      warn,
    );

    if (rejects) {
      await expect(persistence).rejects.toThrow("transcript identity not resolved");
    } else {
      await expect(persistence).resolves.toContain("could not be saved to history");
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("transcript identity not resolved"));
  });

  it("rejects an abandoned partial after its exact transcript session is replaced", async () => {
    const { sessionId } = await createTranscriptFixture();

    await expect(
      persistPartial(
        await partialSnapshot({
          sessionId: `${sessionId}-stale`,
          runId: "stale-placement-run",
          text: "partial from the former session",
          abortOrigin: "placement-abandon",
        }),
      ),
    ).rejects.toThrow("transcript session changed");
  });

  it.each([undefined, "original-revision"])(
    "rejects placement partials when captured revision %s changes without SID rotation",
    async (lifecycleRevision) => {
      const { readTranscript, sessionId, writeEntry } = await createTranscriptFixture();
      await writeEntry({ lifecycleRevision });
      sessionEntryState.lifecycleRevision = lifecycleRevision;
      const snapshot = await partialSnapshot({
        sessionId,
        runId: "placement-revision",
        text: "obsolete placement partial",
        abortOrigin: "placement-abandon",
      });
      await writeEntry({ lifecycleRevision: "next-revision" });
      const before = await readTranscript();
      await expect(persistPartial(snapshot)).rejects.toThrow("session-rebound");
      expect(await readTranscript()).toEqual(before);
    },
  );

  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { readTranscript, sessionId } = await createTranscriptFixture();
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = bufferedContext(sessionId, [[runId, "Partial from run abort"]], {
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
    });

    await abort(context, { sessionKey: "main", runId }, respond);

    expectAborted(respond, [runId]);

    rpcSourceTesting.set(runId, createActiveRun("main", { sessionId }));
    const retryRun = context.chatRunState.getOrCreate(runId);
    retryRun.buffer = "Partial from run abort";
    retryRun.deltaSentAt = Date.now();

    await abort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscript();
    const persisted = collectMessagesWithIdempotencyKey(lines, `${runId}:assistant`);

    expect(persisted).toHaveLength(1);
    expectPartial(persisted[0], runId, "stop");
  });

  it("saves an exact-run partial in its own session when the paired device stops it from another session", async () => {
    const targetKey = "agent:main:target";
    const requestedKey = "agent:main:requested";
    const { readTranscript, sessionId, storePath } = await createTranscriptFixture({
      agentId: "main",
      sessionKey: targetKey,
    });
    const requestedScope = {
      agentId: "main",
      sessionKey: requestedKey,
      sessionId: "requested-session",
      storePath,
    };
    await replaceSessionEntry(requestedScope, {
      sessionId: requestedScope.sessionId,
      updatedAt: Date.now(),
    });
    const before = await loadTranscriptEvents(requestedScope);
    const cfg = createCanonicalAgentConfigFixture({ session: { store: storePath } }).config;
    const actualSessionUtils =
      await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
    vi.spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker").mockImplementation(
      actualSessionUtils.loadGatewaySessionEntryReadOnlyInWorker,
    );
    const runId = "cross-session-partial";
    const partial = "Buffered reply from the target session";
    const active = createActiveRun(targetKey, {
      sessionId,
      owner: { connId: "original-connection", deviceId: "paired-device" },
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => cfg,
      sources: [[runId, active]],
      chatRunState: createAbortTestRunState([[runId, { buffer: partial }]]),
    });
    const respond = vi.fn();

    await abort(context, { sessionKey: requestedKey, runId }, respond, {
      connId: "reconnected-connection",
      connect: { device: { id: "paired-device" }, scopes: ["operator.write"] },
    });

    expectAborted(respond, [runId]);
    expect(active.input.abortSignal.aborted).toBe(true);
    expect(rpcSourceTesting.has(runId)).toBe(false);
    const persisted = collectAssistantRowsWithText(await readTranscript(), partial);
    expect(persisted).toHaveLength(1);
    expectPartial(persisted[0], runId, "stop");
    expect(await loadTranscriptEvents(requestedScope)).toEqual(before);
  });

  it.each([
    { sameRun: false, origin: "rpc" as const, count: 2 },
    { sameRun: true, origin: "placement-abandon" as const, count: 1 },
  ])(
    "deduplicates committed replies by run, not text (sameRun=$sameRun)",
    async ({ sameRun, origin, count }) => {
      const { readTranscript, sessionId, storePath } = await createTranscriptFixture();
      const runId = "aborted-run";
      seedCommittedReply({ sessionId, storePath, runId: sameRun ? runId : "other-run" });
      await persistPartial(
        await partialSnapshot({ runId, sessionId, text: "Completed reply", abortOrigin: origin }),
      );
      const rows = collectAssistantRowsWithText(await readTranscript(), "Completed reply");
      expect(rows).toHaveLength(count);
      if (sameRun) {
        expect(rows[0]?.openclawAbort).toBeUndefined();
      } else {
        expectPartial(rows[1], runId);
      }
    },
  );

  it("does not let non-assistant idempotency collisions suppress abort partial persistence", async () => {
    const { readTranscript, sessionId, storePath } = await createTranscriptFixture();
    const runId = "idem-abort-collision";
    const idempotencyKey = `${runId}:assistant`;
    appendTranscriptMessage(
      { sessionId, storePath },
      {
        ...makeUserMessage("colliding user key", 1),
        idempotencyKey,
      },
    );

    const respond = vi.fn();
    const context = bufferedContext(sessionId, [[runId, "Partial after collision"]]);

    await abort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscript();
    const assistantMessages = collectMessagesWithIdempotencyKey(lines, idempotencyKey).filter(
      (message) => message.role === "assistant",
    );

    expect(assistantMessages).toHaveLength(1);
    expectPartial(assistantMessages[0], runId, "stop");
  });

  it("persists a session-scoped active partial while cancelling queued input", async () => {
    const { readTranscript, sessionId } = await createTranscriptFixture();
    const respond = vi.fn();
    const context = bufferedContext(sessionId, [
      ["run-a", "Session abort partial"],
      ["run-b", "   ", { queued: true }],
    ]);

    await abort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayloadContainsRunIds(payload, ["run-a", "run-b"]);

    const lines = await readTranscript();
    const runAPersisted = findMessageWithIdempotencyKey(lines, "run-a:assistant");
    const runBPersisted = findMessageWithIdempotencyKey(lines, "run-b:assistant");

    expectPartial(runAPersisted, "run-a");
    expect(runBPersisted).toBeUndefined();
  });

  it("does not persist partials from finalizing runs that reject a session abort", async () => {
    const { readTranscript, sessionId } = await createTranscriptFixture();
    const respond = vi.fn();
    const finalizingRun = createActiveRun("main", { sessionId });
    const operation = finalizingRun.input.claim?.operation;
    if (!operation) {
      throw new Error("Expected an admitted finalizing turn");
    }
    operation.freezeAbort();
    const pending = createActiveRun("main", { sessionId, queued: true });
    const context = createChatAbortContext({
      sources: [
        ["run-pending", pending],
        ["run-finalizing", finalizingRun],
      ],
      chatRunState: createAbortTestRunState([
        ["run-pending", { buffer: "Unexecuted input must not become an abort partial" }],
        ["run-finalizing", { buffer: "Completed reply" }],
      ]),
    });

    await abort(context, { sessionKey: "main" }, respond);

    expectAborted(respond, ["run-pending"]);
    expect(pending.input.abortSignal.aborted).toBe(true);
    expect(finalizingRun.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get("run-finalizing")).toBe(finalizingRun);

    const lines = await readTranscript();
    expect(findMessageWithIdempotencyKey(lines, "run-pending:assistant")).toBeUndefined();
    expect(findMessageWithIdempotencyKey(lines, "run-finalizing:assistant")).toBeUndefined();
  });

  it("plain stop aborts raw-alias runs for the same backing session", async () => {
    const { sessionId } = await createTranscriptFixture();
    const runId = "run-stop-raw-alias";
    const active = createActiveRun("alias-main", { sessionId });
    const context = createChatAbortContext({
      sources: [[runId, active]],
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "alias-main", clientRunId: runId }),
    });

    const respond = await stop(context, { sessionKey: "main" });
    expectAborted(respond, [runId]);
    expect(active.input.abortSignal.aborted).toBe(true);
  });

  it.each([
    ["scopes global stop commands to the selected agent", "work"],
    ["scopes bare global stop commands to the migrated default agent", "main"],
  ])("%s", async (_name, selectedAgentId) => {
    const { sessionId, readTranscript } = await createTranscriptFixture({
      agentId: selectedAgentId,
      sessionKey: "global",
    });
    const cfg = globalConfig();
    sessionEntryState.canonicalKey = "global";
    sessionEntryState.cfg = cfg;
    const { mainActive, workActive, sources } = globalRuns(selectedAgentId, sessionId);
    const runId = `run-${selectedAgentId}-global`;
    const context = createChatAbortContext({
      sources,
      chatRunState: createAbortTestRunState([
        [runId, { buffer: `partial ${selectedAgentId} response` }],
      ]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: selectedAgentId,
        clientRunId: runId,
      }),
      getRuntimeConfig: () => cfg,
    });

    const respond = await stop(context, {
      sessionKey: "global",
      ...(selectedAgentId === "work" ? { agentId: selectedAgentId } : {}),
    });

    expectAborted(respond, [runId]);
    expect(mainActive.input.abortSignal.aborted).toBe(selectedAgentId === "main");
    expect(workActive.input.abortSignal.aborted).toBe(selectedAgentId === "work");
    expect(
      findMessageWithIdempotencyKey(await readTranscript(), `${runId}:assistant`),
    ).toBeDefined();
  });

  it.each([
    { sessionKey: "global", agentId: "work", exact: false, legacy: false },
    { sessionKey: "global", agentId: undefined, exact: false, legacy: false },
    { sessionKey: "agent:work:main", agentId: undefined, exact: false, legacy: false },
    { sessionKey: "agent:work:main", agentId: undefined, exact: true, legacy: false },
    { sessionKey: "global", agentId: "work", exact: true, legacy: true },
  ])(
    "scopes global chat.abort to its selected owner: %j",
    async ({ sessionKey, agentId, exact, legacy }) => {
      const expectedAgentId = agentId ?? (sessionKey.startsWith("agent:work:") ? "work" : "main");
      const cfg = legacy ? { agents: { list: [{ id: "work", default: true }] } } : globalConfig();
      const respond = vi.fn();
      const runs = exact
        ? [
            [
              "run-work-global",
              createActiveRun("global", {
                sessionId: "sess-work-global",
                ...(legacy ? {} : { agentId: "work" }),
              }),
            ] as const,
          ]
        : globalRuns().sources;
      const context = createChatAbortContext({
        sources: runs,
        getRuntimeConfig: () => cfg,
      });
      const agentEvents: Array<{ runId: string; sessionKey?: string; agentId?: string }> = [];
      const unsubscribe = onAgentEvent((event) => {
        agentEvents.push({
          runId: event.runId,
          sessionKey: event.sessionKey,
          agentId: event.agentId,
        });
      });

      try {
        await abort(
          context,
          {
            sessionKey,
            ...(agentId ? { agentId } : {}),
            ...(exact && !legacy ? { runId: "run-work-global" } : {}),
          },
          respond,
        );
      } finally {
        unsubscribe();
      }

      expectAborted(respond, [`run-${expectedAgentId}-global`]);
      for (const [runId, active] of runs) {
        expect(active.input.abortSignal.aborted).toBe(runId === `run-${expectedAgentId}-global`);
      }
      if (!exact && agentId) {
        expect(agentEvents).toContainEqual({
          runId: "run-work-global",
          sessionKey: "global",
          agentId: "work",
        });
      }
    },
  );

  it("rejects selected global chat.abort when agentId conflicts with the key agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext({ getRuntimeConfig: globalConfig });

    await abort(
      context,
      {
        sessionKey: "agent:main:main",
        agentId: "work",
      },
      respond,
    );

    const [ok, , error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(error).toMatchObject({
      message: 'agentId "work" does not match session key "agent:main:main"',
    });
  });

  it("does not match stop targets by client-supplied session id without a stored entry", async () => {
    const { sessionId } = await createTranscriptFixture(undefined, {
      sessionId: "client-supplied-session",
      hasEntry: false,
    });
    const active = createActiveRun("third-session", { sessionId });
    const context = createChatAbortContext({
      sources: [["run-stop-client-session", active]],
    });

    const respond = await stop(context, { sessionKey: "other-session", sessionId });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(expectRecord(payload, "abort payload").aborted).toBe(false);
    expect(active.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.has("run-stop-client-session")).toBe(true);
  });

  it("skips run-scoped transcript persistence for hidden internal runs", async () => {
    const { readTranscript, sessionId } = await createTranscriptFixture();
    const runId = "idem-abort-run-hidden";
    const respond = vi.fn();
    const context = bufferedContext(sessionId, [
      [runId, "Hidden partial", { controlUiVisible: false }],
    ]);

    await abort(context, { sessionKey: "main", runId }, respond);

    expectAborted(respond, [runId]);

    const lines = await readTranscript();
    const persisted = findMessageWithIdempotencyKey(lines, `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
});

describe("chat.abort session identity matching", () => {
  it.each([true, false])(
    "matches only the stored session identity (matches=%s)",
    async (matches) => {
      const sessionId = "stored-session";
      setMockSessionEntry({ transcriptPath: "", storePath: "", sessionId });
      const runId = "embedded-run";
      const active = createActiveRun("agent:main:other-key", {
        sessionId: matches ? sessionId : "different-session",
      });
      const context = createChatAbortContext({ sources: [[runId, active]] });
      const respond = vi.fn();
      await abort(context, { sessionKey: "main" }, respond);
      if (matches) {
        expectAborted(respond, [runId]);
      } else {
        const [ok, payload] = requireLastRespondCall(respond);
        expect(ok).toBe(true);
        expect(payload).toEqual({ ok: true, aborted: false, runIds: [] });
      }
      expect(active.input.abortSignal.aborted).toBe(matches);
    },
  );
});
