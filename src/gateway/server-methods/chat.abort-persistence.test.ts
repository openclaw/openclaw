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
  loadCalls: [] as Array<{ sessionKey: string; opts?: { agentId?: string } }>,
}));

function createActiveRun(...[sessionKey, options]: Parameters<typeof createUnscopedRun>) {
  return createUnscopedRun(sessionKey, {
    ...(sessionKey === "main" ? { agentId: "main" } : {}),
    storeScope: sessionEntryState.storePath || "/synthetic/chat-abort-persistence/sessions.db",
    ...options,
  });
}

function loadAbortSessionFixture(sessionKey: string, opts?: { agentId?: string }) {
  sessionEntryState.loadCalls.push({ sessionKey, opts });
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
      loadAbortSessionFixture(params.key, { agentId: params.agentId }),
  };
});

const { handleDirectExternalChatSend } = await import("./chat-send-external-entry.js");

type AbortOptions = Parameters<typeof invokeChatAbortHandler>[0];

function abort(
  context: AbortOptions["context"],
  request: AbortOptions["request"],
  respond: NonNullable<AbortOptions["respond"]>,
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

function stop(
  context: AbortOptions["context"],
  params: Parameters<typeof handleDirectExternalChatSend>[0]["params"],
  respond: NonNullable<AbortOptions["respond"]>,
) {
  return handleDirectExternalChatSend({
    params,
    respond,
    context: context as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
}

function globalContext(overrides: Parameters<typeof createChatAbortContext>[0] = {}) {
  return createChatAbortContext({
    getRuntimeConfig: () =>
      createCanonicalAgentConfigFixture({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }).config,
    ...overrides,
  });
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

const transcriptFixtures = new Map<
  string,
  { sessionId: string; storePath: string; agentId: string; sessionKey: string }
>();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-chat-abort-");

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const fixture = transcriptFixtures.get(transcriptPath);
  if (!fixture) {
    throw new Error(`unknown transcript fixture: ${transcriptPath}`);
  }
  return (await loadTranscriptEvents({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
  })) as TranscriptLine[];
}

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
  sessionEntryState.loadCalls = [];
}

async function createTranscriptFixture(owner = { agentId: "main", sessionKey: "main" }) {
  const dir = sessionDirs.make();
  const sessionId = "sess-main";
  const storePath = path.join(dir, "sessions.json");
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: owner.agentId,
    sessionId,
    storePath,
  });
  // The accessor resolves transcript targets from the persisted store, so the
  // fixture seeds a real entry instead of relying on the mocked gateway wrapper.
  await replaceSessionEntry(
    { ...owner, storePath },
    { sessionId, sessionFile: transcriptPath, updatedAt: Date.now() },
  );
  transcriptFixtures.set(transcriptPath, { sessionId, storePath, ...owner });
  setMockSessionEntry({ transcriptPath, storePath, sessionId });
  return { transcriptPath, sessionId, storePath };
}

function appendTranscriptMessage(params: {
  idempotencyKey: string;
  message: Record<string, unknown>;
  sessionId: string;
  storePath: string;
}) {
  const seeded = appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: "main",
      storePath: params.storePath,
    },
    {
      idempotencyLookup: "caller-checked",
      message: {
        ...params.message,
        idempotencyKey: params.idempotencyKey,
      },
      now: 1,
    },
  );
  expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
}

function seedCommittedReply(params: { sessionId: string; storePath: string; runId?: string }) {
  const seeded = appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: "main",
      storePath: params.storePath,
    },
    {
      idempotencyLookup: "caller-checked",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Completed reply" }],
        timestamp: Date.now(),
        stopReason: "stop",
        ...(params.runId ? { __openclaw: { runId: params.runId } } : {}),
      },
      now: 1,
    },
  );
  expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
}

async function createMissingEntryFixture() {
  const dir = sessionDirs.make();
  const storePath = path.join(dir, "sessions.json");
  const sessionId = "client-supplied-session";
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  transcriptFixtures.set(transcriptPath, {
    sessionId,
    storePath,
    agentId: "main",
    sessionKey: "main",
  });
  setMockSessionEntry({ transcriptPath, storePath, sessionId, hasEntry: false });
  return { sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentEventsForTest();
  transcriptFixtures.clear();
});

describe("chat abort transcript persistence", () => {
  it("commits an already-cancelled parent partial when revocation fences later worker cancellation", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture();
    const revision = "original-generation";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "main", storePath },
      {
        sessionId,
        lifecycleRevision: revision,
        updatedAt: 1,
      },
    );
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
      sources: new Map([["parent", parent]]),
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
    const lines = await readTranscriptLines(transcriptPath);
    const committed = collectMessagesWithIdempotencyKey(lines, "parent:assistant");
    expect(committed).toHaveLength(1);
    expectPersistedAbortMessage(committed[0], {
      idempotencyKey: "parent:assistant",
      origin: "rpc",
      runId: "parent",
    });
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
    const persistence = persistAbortedPartials({
      context: { logGateway: { warn } },
      snapshots: [
        captureAbortedPartial({
          session: await prepareChatAbortSessionSnapshot({
            cfg: sessionEntryState.cfg,
            key: "main",
            agentId: "main",
          }),
          sessionKey: "main",
          sessionId,
          runId: "failed-abort-run",
          text: "partial that cannot be persisted",
          abortOrigin: origin,
        }),
      ],
    });

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
      persistAbortedPartials({
        context: { logGateway: { warn: vi.fn() } },
        snapshots: [
          captureAbortedPartial({
            session: await prepareChatAbortSessionSnapshot({
              cfg: sessionEntryState.cfg,
              key: "main",
              agentId: "main",
            }),
            sessionKey: "main",
            sessionId: `${sessionId}-stale`,
            runId: "stale-placement-run",
            text: "partial from the former session",
            abortOrigin: "placement-abandon",
          }),
        ],
      }),
    ).rejects.toThrow("transcript session changed");
  });

  it.each([undefined, "original-revision"])(
    "rejects placement partials when captured revision %s changes without SID rotation",
    async (lifecycleRevision) => {
      const { transcriptPath, sessionId, storePath } = await createTranscriptFixture();
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: "main" },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision,
        },
      );
      sessionEntryState.lifecycleRevision = lifecycleRevision;
      const snapshot = captureAbortedPartial({
        session: await prepareChatAbortSessionSnapshot({
          cfg: sessionEntryState.cfg,
          key: "main",
          agentId: "main",
        }),
        sessionKey: "main",
        sessionId,
        runId: "placement-revision",
        text: "obsolete placement partial",
        abortOrigin: "placement-abandon",
      });
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: "main" },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision: "next-revision",
        },
      );
      const before = await readTranscriptLines(transcriptPath);
      await expect(
        persistAbortedPartials({
          context: { logGateway: { warn: vi.fn() } },
          snapshots: [snapshot],
        }),
      ).rejects.toThrow("session-rebound");
      expect(await readTranscriptLines(transcriptPath)).toEqual(before);
    },
  );

  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture();
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

    const [ok1, payload1] = requireLastRespondCall(respond);
    expect(ok1).toBe(true);
    expectAbortPayload(payload1, { runIds: [runId] });

    rpcSourceTesting.set(runId, createActiveRun("main", { sessionId }));
    const retryRun = context.chatRunState.getOrCreate(runId);
    retryRun.buffer = "Partial from run abort";
    retryRun.deltaSentAt = Date.now();

    await abort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = collectMessagesWithIdempotencyKey(lines, `${runId}:assistant`);

    expect(persisted).toHaveLength(1);
    expectPersistedAbortMessage(persisted[0], {
      idempotencyKey: `${runId}:assistant`,
      origin: "rpc",
      runId,
      stopReason: "stop",
    });
  });

  it("saves an exact-run partial in its own session when the paired device stops it from another session", async () => {
    const targetKey = "agent:main:target";
    const requestedKey = "agent:main:requested";
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture({
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
      sources: new Map([[runId, active]]),
      chatRunState: createAbortTestRunState([[runId, { buffer: partial }]]),
    });
    const respond = vi.fn();

    await abort(context, { sessionKey: requestedKey, runId }, respond, {
      connId: "reconnected-connection",
      connect: { device: { id: "paired-device" }, scopes: ["operator.write"] },
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.input.abortSignal.aborted).toBe(true);
    const persisted = collectAssistantRowsWithText(
      await readTranscriptLines(transcriptPath),
      partial,
    );
    expect(persisted).toHaveLength(1);
    expectPersistedAbortMessage(persisted[0], {
      idempotencyKey: `${runId}:assistant`,
      origin: "rpc",
      runId,
      stopReason: "stop",
    });
    expect(await loadTranscriptEvents(requestedScope)).toEqual(before);
  });

  it("keeps an abort partial when the committed reply belongs to a different run", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture();
    // An earlier run committed the identical reply. Text equality alone would
    // drop this run's abort partial, so the skip must be run-scoped.
    seedCommittedReply({ sessionId, storePath, runId: "settled-other-run" });

    await persistAbortedPartials({
      context: { logGateway: { warn: vi.fn() } },
      snapshots: [
        captureAbortedPartial({
          session: await prepareChatAbortSessionSnapshot({
            cfg: sessionEntryState.cfg,
            key: "main",
            agentId: "main",
          }),
          sessionKey: "main",
          runId: "aborted-later-run",
          sessionId,
          text: "Completed reply",
          abortOrigin: "rpc",
        }),
      ],
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");
    expect(committedRows).toHaveLength(2);
    expectPersistedAbortMessage(committedRows[1], {
      idempotencyKey: "aborted-later-run:assistant",
      origin: "rpc",
      runId: "aborted-later-run",
    });
  });

  it("treats a declined committed-reply skip as a decision, not a placement-abandon failure", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture();
    seedCommittedReply({ sessionId, storePath, runId: "stalled-placement-run" });

    // The skip happens inside the writer queue after the append decision was
    // handed off, so it must not surface as a failed placement abandonment.
    await persistAbortedPartials({
      context: { logGateway: { warn: vi.fn() } },
      snapshots: [
        captureAbortedPartial({
          session: await prepareChatAbortSessionSnapshot({
            cfg: sessionEntryState.cfg,
            key: "main",
            agentId: "main",
          }),
          sessionKey: "main",
          runId: "stalled-placement-run",
          sessionId,
          text: "Completed reply",
          abortOrigin: "placement-abandon",
        }),
      ],
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");
    expect(committedRows).toHaveLength(1);
    expect(committedRows[0]?.openclawAbort).toBeUndefined();
  });

  it("does not let non-assistant idempotency collisions suppress abort partial persistence", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture();
    const runId = "idem-abort-collision";
    const idempotencyKey = `${runId}:assistant`;
    appendTranscriptMessage({
      idempotencyKey,
      sessionId,
      storePath,
      message: makeUserMessage("colliding user key", 1),
    });

    const respond = vi.fn();
    const context = bufferedContext(sessionId, [[runId, "Partial after collision"]]);

    await abort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const assistantMessages = collectMessagesWithIdempotencyKey(lines, idempotencyKey).filter(
      (message) => message.role === "assistant",
    );

    expect(assistantMessages).toHaveLength(1);
    expectPersistedAbortMessage(assistantMessages[0], {
      idempotencyKey,
      origin: "rpc",
      runId,
      stopReason: "stop",
    });
  });

  it("persists a session-scoped active partial while cancelling queued input", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture();
    const respond = vi.fn();
    const context = bufferedContext(sessionId, [
      ["run-a", "Session abort partial"],
      ["run-b", "   ", { queued: true }],
    ]);

    await abort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayloadContainsRunIds(payload, ["run-a", "run-b"]);

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = findMessageWithIdempotencyKey(lines, "run-a:assistant");
    const runBPersisted = findMessageWithIdempotencyKey(lines, "run-b:assistant");

    expectPersistedAbortMessage(runAPersisted, {
      idempotencyKey: "run-a:assistant",
      origin: "rpc",
      runId: "run-a",
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("does not persist partials from finalizing runs that reject a session abort", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture();
    const respond = vi.fn();
    const finalizingRun = createActiveRun("main", { sessionId });
    const operation = finalizingRun.input.claim?.operation;
    if (!operation) {
      throw new Error("Expected an admitted finalizing turn");
    }
    operation.freezeAbort();
    const pending = createActiveRun("main", { sessionId, queued: true });
    const context = createChatAbortContext({
      sources: new Map([
        ["run-pending", pending],
        ["run-finalizing", finalizingRun],
      ]),
      chatRunState: createAbortTestRunState([
        ["run-pending", { buffer: "Unexecuted input must not become an abort partial" }],
        ["run-finalizing", { buffer: "Completed reply" }],
      ]),
    });

    await abort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-pending"] });
    expect(pending.input.abortSignal.aborted).toBe(true);
    expect(finalizingRun.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get("run-finalizing")).toBe(finalizingRun);

    const lines = await readTranscriptLines(transcriptPath);
    expect(findMessageWithIdempotencyKey(lines, "run-pending:assistant")).toBeUndefined();
    expect(findMessageWithIdempotencyKey(lines, "run-finalizing:assistant")).toBeUndefined();
  });

  it("plain stop aborts raw-alias runs for the same backing session", async () => {
    const { sessionId } = await createTranscriptFixture();
    const respond = vi.fn();
    const runId = "run-stop-raw-alias";
    const active = createActiveRun("alias-main", { sessionId });
    const context = createChatAbortContext({
      sources: new Map([[runId, active]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "alias-main", clientRunId: runId }),
    });

    await stop(
      context,
      {
        sessionKey: "main",
        message: "stop",
        idempotencyKey: "idem-stop-raw-alias",
      },
      respond,
    );

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.input.abortSignal.aborted).toBe(true);
  });

  it.each([
    ["scopes global stop commands to the selected agent", "work"],
    ["scopes bare global stop commands to the migrated default agent", "main"],
  ])("%s", async (_name, selectedAgentId) => {
    const { sessionId, transcriptPath } = await createTranscriptFixture({
      agentId: selectedAgentId,
      sessionKey: "global",
    });
    const cfg = createCanonicalAgentConfigFixture({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    }).config;
    sessionEntryState.canonicalKey = "global";
    sessionEntryState.cfg = cfg;
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: selectedAgentId === "main" ? sessionId : "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: selectedAgentId === "work" ? sessionId : "sess-work-global",
      agentId: "work",
    });
    const runId = `run-${selectedAgentId}-global`;
    const context = createChatAbortContext({
      sources: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
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

    await stop(
      context,
      {
        sessionKey: "global",
        ...(selectedAgentId === "work" ? { agentId: selectedAgentId } : {}),
        message: "stop",
        idempotencyKey: `idem-stop-${selectedAgentId === "work" ? "work" : "default"}-global`,
      },
      respond,
    );

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(mainActive.input.abortSignal.aborted).toBe(selectedAgentId === "main");
    expect(workActive.input.abortSignal.aborted).toBe(selectedAgentId === "work");
    expect(
      findMessageWithIdempotencyKey(
        await readTranscriptLines(transcriptPath),
        `${runId}:assistant`,
      ),
    ).toBeDefined();
    expect(context.logGateway.warn).not.toHaveBeenCalled();
    if (selectedAgentId === "work") {
      expect(sessionEntryState.loadCalls).toContainEqual({
        sessionKey: "global",
        opts: { agentId: "work" },
      });
    }
  });

  it.each([
    ["scopes global chat.abort requests to the selected agent", "global", "work", false],
    [
      "scopes bare global chat.abort requests to the migrated default agent",
      "global",
      undefined,
      true,
    ],
    [
      "infers selected global chat.abort scope from agent-prefixed aliases",
      "agent:work:main",
      undefined,
      true,
    ],
  ])("%s", async (_name, sessionKey, agentId, needsGlobalConfig) => {
    const expectedAgentId = agentId ?? (sessionKey.startsWith("agent:work:") ? "work" : "main");
    const cfg = createCanonicalAgentConfigFixture({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    }).config;
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      sources: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
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
      await abort(context, { sessionKey, ...(agentId ? { agentId } : {}) }, respond);
    } finally {
      unsubscribe();
    }

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [`run-${expectedAgentId}-global`] });
    expect(mainActive.input.abortSignal.aborted).toBe(expectedAgentId === "main");
    expect(workActive.input.abortSignal.aborted).toBe(expectedAgentId === "work");
    if (!needsGlobalConfig) {
      expect(agentEvents).toContainEqual({
        runId: "run-work-global",
        sessionKey: "global",
        agentId: "work",
      });
    }
  });

  it("rejects selected global chat.abort when agentId conflicts with the key agent", async () => {
    const respond = vi.fn();
    const context = globalContext();

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
    expect(error).toEqual(
      expect.objectContaining({
        message: 'agentId "work" does not match session key "agent:main:main"',
      }),
    );
  });

  it("accepts selected global chat.abort run ids with agent-prefixed aliases", async () => {
    const respond = vi.fn();
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = globalContext({
      sources: new Map([["run-work-global", workActive]]),
    });

    await abort(
      context,
      {
        sessionKey: "agent:work:main",
        runId: "run-work-global",
      },
      respond,
    );

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(workActive.input.abortSignal.aborted).toBe(true);
  });

  it("uses the configured default agent for legacy unscoped global aborts", async () => {
    const respond = vi.fn();
    const active = createActiveRun("global", {
      sessionId: "sess-work-global",
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({ agents: { list: [{ id: "work", default: true }] } }),
      sources: new Map([["run-work-global", active]]),
    });

    await abort(
      context,
      {
        sessionKey: "global",
        agentId: "work",
      },
      respond,
    );

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(active.input.abortSignal.aborted).toBe(true);
  });

  it("does not match stop targets by client-supplied session id without a stored entry", async () => {
    const { sessionId } = await createMissingEntryFixture();
    const respond = vi.fn();
    const active = createActiveRun("third-session", { sessionId });
    const context = createChatAbortContext({
      sources: new Map([["run-stop-client-session", active]]),
    });

    await stop(
      context,
      {
        sessionKey: "other-session",
        sessionId,
        message: "stop",
        idempotencyKey: "idem-stop-client-session",
      },
      respond,
    );

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(expectRecord(payload, "abort payload").aborted).toBe(false);
    expect(active.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.has("run-stop-client-session")).toBe(true);
  });

  it("skips run-scoped transcript persistence for hidden internal runs", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture();
    const runId = "idem-abort-run-hidden";
    const respond = vi.fn();
    const context = bufferedContext(sessionId, [
      [runId, "Hidden partial", { controlUiVisible: false }],
    ]);

    await abort(context, { sessionKey: "main", runId }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = findMessageWithIdempotencyKey(lines, `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
});

describe("chat.abort session identity matching", () => {
  it("matches an active run by stored sessionId when sessionKey differs", async () => {
    const storedSessionId = "sess-stored-abc";
    setMockSessionEntry({ transcriptPath: "", storePath: "", sessionId: storedSessionId });
    const runId = "embedded-run-1";
    const active = createActiveRun("agent:main:embedded-key", { sessionId: storedSessionId });
    const context = createChatAbortContext({
      sources: new Map([[runId, active]]),
    });
    const respond = vi.fn();

    await abort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.input.abortSignal.aborted).toBe(true);
    expect(sessionEntryState.loadCalls).toContainEqual({
      sessionKey: "agent:main:main",
      opts: { agentId: "main" },
    });
  });

  it("does not match a run whose sessionId differs from the stored entry", async () => {
    setMockSessionEntry({ transcriptPath: "", storePath: "", sessionId: "sess-stored-xyz" });
    const runId = "embedded-run-2";
    const active = createActiveRun("agent:main:other-key", { sessionId: "sess-different" });
    const context = createChatAbortContext({
      sources: new Map([[runId, active]]),
    });
    const respond = vi.fn();

    await abort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload).toEqual({ ok: true, aborted: false, runIds: [] });
    expect(active.input.abortSignal.aborted).toBe(false);
  });
});
