import { mkdir } from "node:fs/promises";
import { backup } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  appendTranscriptEvent,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  readSessionTranscriptWatermark,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  waitForSessionTranscriptProjection,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  getSessionColdStorageStatus,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionActivitySummaryHandlers } from "./server-methods/session-activity-summary.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import type { RespondFn } from "./server-methods/types.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { listSessionFixture } from "./session-list.test-support.js";
import type { defaultCompleteModel } from "./session-observer-model.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../config/sessions/session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const target = { key: "agent:main:recap", agentId: "main" };
const scope = { sessionKey: target.key, agentId: target.agentId, sessionId: "recap-session" };
const prepared = {
  config: {},
  authProfileId: undefined,
  provider: "test",
  model: "utility",
  agentId: "main",
  agentDir: "/tmp/unused",
  outputTextPolicy: "strict-visible" as const,
};
const result = (text: string) => ({
  text,
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
});

async function messages(count: number, start = 0) {
  await persistSessionTranscriptTurn(scope, {
    messages: Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        eventId: `message-${index}`,
        parentId: index ? `message-${index - 1}` : null,
        message: {
          role: index % 2 ? "assistant" : "user",
          content: `Outcome ${index}`,
          timestamp: Date.now(),
        },
      };
    }),
    touchSessionEntry: false,
  });
}

function terminal(service: SessionActivitySummaryService) {
  service.handleEvent({
    ...target,
    sessionKey: target.key,
    sessionId: scope.sessionId,
    runId: "run",
    seq: 1,
    ts: Date.now(),
    stream: "lifecycle",
    data: { phase: "end" },
  });
}

describe("Activity recap lifecycle with the canonical session store", () => {
  let testState: OpenClawTestState;
  let cfg: OpenClawConfig;
  let service: SessionActivitySummaryService;
  let residentProjection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  const complete = vi.fn(async (_params: Parameters<typeof defaultCompleteModel>[0]) =>
    result("Completed the requested work."),
  );
  const prepare = vi.fn(async () => prepared);
  const changed = vi.fn();
  const read = () => loadSessionEntryReadOnly(scope);
  const view = () => projectSessionActivitySummary({ ...target, cfg, entry: read() });

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    complete.mockReset().mockImplementation(async () => result("Completed the requested work."));
    prepare.mockReset().mockImplementation(async () => prepared);
    changed.mockReset();
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle-1",
      updatedAt: 1,
    });
    service = createSessionActivitySummaries({
      getConfig: () => cfg,
      getSessionRowProjection: () => residentProjection,
      onChanged: changed,
      prepareModel: prepare,
      completeModel: complete,
    });
  });
  afterEach(async () => {
    archiveMaterializationHook.beforeMaterialize = undefined;
    clearAgentRunContext("recap-context-run");
    await service.dispose();
    residentProjection?.dispose();
    residentProjection = undefined;
    await testState.cleanup();
  });

  it("does not generate conversation recaps for Cron runs", async () => {
    const cronTarget = {
      key: "agent:main:cron:job-1:run:run-1",
      agentId: "main",
    };
    await upsertSessionEntryCore(
      {
        agentId: cronTarget.agentId,
        sessionKey: cronTarget.key,
      },
      {
        sessionId: "cron-run",
        lifecycleRevision: "lifecycle-1",
        updatedAt: 1,
        activitySummary: {
          version: 1,
          formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
          text: "A cached Cron recap must not be exposed.",
          updatedAt: 1,
          sessionId: "cron-run",
          lifecycleRevision: "lifecycle-1",
          generation: null,
          maxSeq: 0,
          leafEntryId: null,
          coveredMessages: 0,
          totalMessages: 0,
          omittedContent: false,
        },
      },
    );

    expect(service.ensure(cronTarget)).toEqual({ state: "unavailable" });
    expect(prepare).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("backfills chronological chunks cumulatively and shares the durable result across viewers and restart", async () => {
    await messages(70);
    await persistSessionTranscriptTurn(scope, {
      messages: Array.from({ length: 129 }, (_, offset) => ({
        eventId: `message-${70 + offset}`,
        parentId: `message-${69 + offset}`,
        message:
          offset === 128
            ? {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Old progress",
                    textSignature: '{"v":1,"phase":"commentary"}',
                  },
                  {
                    type: "text",
                    text: "Shipped the fix. Waiting for review.",
                    textSignature: '{"v":1,"phase":"final_answer"}',
                  },
                ],
              }
            : {
                role: offset % 2 ? "toolResult" : "assistant",
                content:
                  offset % 2
                    ? "Internal tool log dump"
                    : [{ type: "toolCall", name: "internal_tool", arguments: {} }],
              },
      })),
      touchSessionEntry: false,
    });
    const originalActivity = read()?.updatedAt;
    complete.mockImplementation(async () =>
      result(`Recap through batch ${complete.mock.calls.length}.`),
    );
    for (let index = 0; index < 12; index += 1) {
      service.ensure(target);
    }
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(3);
    const first = complete.mock.calls[0]?.[0];
    const second = complete.mock.calls[1]?.[0];
    expect(first).toMatchObject({ model: "utility", provider: "test" });
    expect(JSON.parse(first!.prompt).messages[0]).toContain("Outcome 0");
    expect(JSON.parse(first!.prompt).messages.at(-1)).toContain("Outcome 63");
    expect(JSON.parse(second!.prompt)).toMatchObject({ previousRecap: "Recap through batch 1." });
    expect(JSON.parse(second!.prompt).messages.at(-1)).toContain("Outcome 69");
    expect(JSON.parse(complete.mock.calls[2]![0].prompt).messages).toEqual([
      "assistant: Shipped the fix. Waiting for review.",
    ]);
    expect(complete.mock.calls.map(([request]) => request.prompt).join("\n")).not.toMatch(
      /Internal tool log dump|internal_tool|Old progress/,
    );
    expect(read()?.activitySummary).toMatchObject({
      coveredMessages: 199,
      totalMessages: 199,
      version: 1,
    });
    expect(read()?.updatedAt).toBe(originalActivity);
    await service.dispose();
    service = createSessionActivitySummaries({
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: prepare,
      completeModel: complete,
    });
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("keeps describe non-current while the newer first-turn recap is queued or held", async () => {
    await messages(1);
    complete.mockResolvedValueOnce(result("Only the request is recorded."));
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    const previousWatermark = readSessionTranscriptWatermark(scope);
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    const context = bindSessionRowProjection(
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
      () => projection,
    );
    const describeSession = async () => {
      const responses: Parameters<RespondFn>[] = [];
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "recap-readiness", method: "sessions.describe", params: target },
        params: target,
        client: null,
        context,
        respond: (...response) => responses.push(response),
        isWebchatConnect: () => false,
      });
      expect(responses).toHaveLength(1);
      expect(responses[0]?.[0]).toBe(true);
      return responses[0]?.[1];
    };
    const completion = createDeferred<ReturnType<typeof result>>();
    try {
      // Prime the real resident projection with the older, valid current summary.
      expect(await describeSession()).toMatchObject({
        session: {
          key: target.key,
          sessionId: scope.sessionId,
          activitySummary: { state: "current", text: "Only the request is recorded." },
        },
      });
      expect(read()?.activitySummary).toMatchObject({
        ...previousWatermark,
        coveredMessages: 1,
        totalMessages: 1,
      });
      complete.mockImplementationOnce(() => completion.promise);
      await messages(1, 1);
      const latestWatermark = readSessionTranscriptWatermark(scope);
      expect(latestWatermark.maxSeq).not.toBe(previousWatermark.maxSeq);
      service.handleTranscript({ target: { ...scope }, lifecycleRevision: "lifecycle-1" });
      const updating = {
        session: {
          key: target.key,
          sessionId: scope.sessionId,
          activitySummary: { state: "updating", text: "Only the request is recorded." },
        },
      };
      expect(await describeSession()).toMatchObject(updating);

      terminal(service);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      // No model result can commit while this exact completion is held.
      expect(await describeSession()).toMatchObject(updating);
      expect(read()?.activitySummary).toMatchObject({
        ...previousWatermark,
        coveredMessages: 1,
        totalMessages: 1,
      });

      const published = createDeferred<ReturnType<typeof view>>();
      changed.mockImplementationOnce(() => published.resolve(view()));
      completion.resolve(result("Completed the first turn."));
      expect(await published.promise).toMatchObject({
        state: "current",
        text: "Completed the first turn.",
      });
      expect(await describeSession()).toMatchObject({
        session: {
          key: target.key,
          sessionId: scope.sessionId,
          activitySummary: { state: "current", text: "Completed the first turn." },
        },
      });
      expect(read()?.activitySummary).toMatchObject({
        ...latestWatermark,
        sessionId: scope.sessionId,
        lifecycleRevision: "lifecycle-1",
        coveredMessages: 2,
        totalMessages: 2,
      });
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      completion.resolve(result("Completed the first turn."));
      try {
        await service.dispose();
      } finally {
        projection.dispose();
      }
    }
  });

  it("commits a recap without decoding unrelated retained session entries", async () => {
    await messages(2);
    const unrelatedLabel = "Unrelated retained recap inventory marker";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:unrelated-recap" },
      {
        sessionId: "unrelated-recap-session",
        updatedAt: Date.now(),
        label: unrelatedLabel,
        skillsSnapshot: { prompt: "Unrelated saved prompt. ".repeat(1024), skills: [] },
      },
    );
    read();
    const parse = vi.spyOn(JSON, "parse");
    try {
      service.ensure(target);
      await vi.waitFor(() => expect(view()?.state).toBe("current"));
      expect(read()?.activitySummary?.coveredMessages).toBe(2);
      expect(parse.mock.calls.some(([json]) => json.includes(unrelatedLabel))).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });

  it("uses committed resident facts for recap notifications and current-authority checks", async () => {
    await messages(2);
    const prompt = "Saved recap prompt marker. ".repeat(40_000);
    await patchSessionEntryCore(scope, () => ({ skillsSnapshot: { prompt, skills: [] } }));
    const before = read()!;
    const completion = createDeferred<ReturnType<typeof result>>();
    complete.mockImplementationOnce(() => completion.promise);
    residentProjection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    await residentProjection.ensureMaterialized();
    service.ensure(target);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const queries = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (let index = 0; index < 50; index += 1) {
        service.handleTranscript({ target: { ...scope }, lifecycleRevision: "lifecycle-1" });
        complete.mock.calls[0]![0].assertCurrent?.();
      }
      expect(queries.queries).toHaveLength(0);
      expect(parse.mock.calls.some(([json]) => json.includes("Saved recap prompt marker."))).toBe(
        false,
      );
      expect(complete).toHaveBeenCalledTimes(1);
      queries.restore();
      await patchSessionEntryCore(scope, () => ({ initializationPending: true }), {
        preserveActivity: true,
      });
      // A committed identity change fences requests before display rows finish refreshing.
      expect(() => complete.mock.calls[0]![0].assertCurrent?.()).toThrow(
        "Activity recap lifecycle or utility model changed",
      );
      await patchSessionEntryCore(scope, () => ({ initializationPending: undefined }), {
        preserveActivity: true,
      });
    } finally {
      parse.mockRestore();
      queries.restore();
      completion.resolve(result("Completed the requested work."));
    }
    // Transcript notifications defer the dirty follow-up until the refresh interval;
    // the terminal event requests its immediate completion without another model call.
    expect(view()?.state).toBe("updating");
    terminal(service);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(read()).toMatchObject({
      sessionId: before.sessionId,
      lifecycleRevision: before.lifecycleRevision,
      updatedAt: before.updatedAt,
      skillsSnapshot: before.skillsSnapshot,
      activitySummary: { text: "Completed the requested work.", coveredMessages: 2 },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("refreshes new work, catches up after archiving, and makes no calls for idle metadata changes", async () => {
    await messages(2);
    terminal(service);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    await patchSessionEntryCore(scope, () => ({ archivedAt: Date.now(), label: "Archived work" }));
    service.handleLifecycle({ sessionKey: target.key, agentId: target.agentId, reason: "archive" });
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(1);
    await messages(2, 2);
    service.handleTranscript({ target: { ...scope }, lifecycleRevision: "lifecycle-1" });
    expect(view()?.state).toBe("updating");
    expect(complete).toHaveBeenCalledTimes(1);
    terminal(service);
    await vi.waitFor(() => expect(read()?.activitySummary?.coveredMessages).toBe(4));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(read()?.archivedAt).toBeDefined();
  });

  it.each(["reset", "delete"] as const)(
    "rejects a delayed completion after session %s",
    async (kind) => {
      await messages(2);
      let finish!: (value: ReturnType<typeof result>) => void;
      complete.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      service.ensure(target);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
      if (kind === "delete") {
        await deleteSessionEntryLifecycle({
          agentId: "main",
          archiveTranscript: false,
          storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
          target: { canonicalKey: target.key, storeKeys: [target.key] },
        });
      } else {
        await patchSessionEntryCore(scope, () => ({
          lifecycleRevision: "lifecycle-2",
          activitySummary: undefined,
        }));
      }
      finish(result("Stale outcome must never be published."));
      await vi.waitFor(() => expect(view()?.state).not.toBe("updating"));
      expect(read()?.activitySummary).toBeUndefined();
    },
  );

  it.each(["initialization", "lifecycle", "utility-model"] as const)(
    "rejects a recap when %s changes while its write is queued",
    async (change) => {
      await messages(2);
      const completion = createDeferred<ReturnType<typeof result>>();
      complete.mockImplementationOnce(() => completion.promise);
      service.ensure(target);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

      const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const before = read()!;
      const releaseWriter = createDeferred();
      const writerScope = { agentId: scope.agentId, path: database.path };
      const blocker = runExclusiveSqliteSessionWrite(
        writerScope,
        async () => {
          await releaseWriter.promise;
          if (change === "utility-model") {
            cfg = { agents: { defaults: { utilityModel: "test/replacement-utility" } } };
          } else {
            runOpenClawAgentWriteTransaction((current) => {
              writeSessionEntry(current, target.key, {
                ...before,
                ...(change === "initialization"
                  ? { initializationPending: true }
                  : { lifecycleRevision: "lifecycle-2" }),
              });
            }, writerScope);
          }
        },
        "session-entry.patch",
      );
      try {
        completion.resolve(result("Outdated recap must not be stored."));
        await vi.waitFor(() =>
          expect(SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending.length).toBeGreaterThan(
            0,
          ),
        );
        const beforeSettlement = changed.mock.calls.length;
        releaseWriter.resolve();
        await blocker;
        await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(beforeSettlement));
        expect(read()?.activitySummary).toBeUndefined();
        expect(view()?.state).not.toBe("current");
        expect(complete).toHaveBeenCalledTimes(1);
        if (change === "utility-model" || change === "initialization") {
          if (change === "initialization") {
            await patchSessionEntryCore(scope, () => ({ initializationPending: undefined }));
          }
          service.ensure(target);
          await vi.waitFor(() => expect(view()?.state).toBe("current"));
          expect(complete).toHaveBeenCalledTimes(2);
        }
      } finally {
        completion.resolve(result("Outdated recap must not be stored."));
        releaseWriter.resolve();
        await blocker;
      }
    },
  );

  it("keeps a delayed recap from invalidating deletion while its archive is prepared", async () => {
    await messages(2);
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    await messages(2, 2);
    const completion = createDeferred<ReturnType<typeof result>>();
    complete.mockImplementationOnce(() => completion.promise);
    service.ensure(target);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));

    const materializationStarted = createDeferred();
    const materializationReleased = createDeferred();
    archiveMaterializationHook.beforeMaterialize = async () => {
      materializationStarted.resolve();
      await materializationReleased.promise;
    };
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
    const capturedEntry = read();
    const deletion = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [target.key, scope.sessionId],
      run: () =>
        deleteSessionEntryLifecycle({
          agentId: target.agentId,
          archiveTranscript: true,
          expectedEntry: capturedEntry,
          storePath,
          target: { canonicalKey: target.key, storeKeys: [target.key] },
        }),
    });
    let entryDuringDeletion: ReturnType<typeof read>;
    try {
      await materializationStarted.promise;
      completion.resolve(result("This later recap must not interrupt deletion."));
      await vi.waitFor(() => expect(view()?.state).not.toBe("updating"));
      entryDuringDeletion = read();
    } finally {
      completion.resolve(result("This later recap must not interrupt deletion."));
      materializationReleased.resolve();
      await deletion;
    }
    expect(entryDuringDeletion).toEqual(capturedEntry);
    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await service.dispose();
    expect(read()).toBeUndefined();
  });

  it("invalidates cached projection after an offline branch change without changing activity ordering", async () => {
    await messages(3);
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    await service.dispose();
    const oldActivity = read()?.updatedAt;
    const oldWatermark = readSessionTranscriptWatermark(scope);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "rewind",
      parentId: "message-0",
      targetId: "message-0",
    });
    expect(readSessionTranscriptWatermark(scope).generation).toBe(oldWatermark.generation);
    expect(read()?.updatedAt).toBe(oldActivity);
    expect(view()?.state).toBe("stale");
    // Offline edits rebuild asynchronously; finish the fixture before restarting its observer.
    await waitForSessionTranscriptProjection(scope);
    service = createSessionActivitySummaries({
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: prepare,
      completeModel: complete,
    });
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].prompt)).toMatchObject({
      previousRecap: "",
      messages: ["user: Outcome 0"],
    });
    const entry = read()!;
    const ordinary = await listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [target.key]: entry },
      opts: {},
    });
    expect(ordinary.sessions[0]?.activitySummary).toBeUndefined();
    const activity = await listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [target.key]: entry },
      opts: { includeActivitySummary: true },
    });
    expect(activity.sessions[0]?.activitySummary).toMatchObject({
      text: "Completed the requested work.",
      state: "current",
    });
  });

  it("does not let timeout release a preparation slot or dispatch a late model request", async () => {
    await messages(1);
    const secondTarget = { key: "agent:main:second-recap", agentId: "main" };
    const thirdTarget = { key: "agent:other:third-recap", agentId: "other" };
    cfg.agents!.list = [{ id: "main" }, { id: "other", utilityModel: "test/other" }];
    for (const other of [secondTarget, thirdTarget]) {
      const otherScope = { agentId: other.agentId, sessionKey: other.key, sessionId: other.key };
      await upsertSessionEntryCore(otherScope, { sessionId: other.key, updatedAt: 1 });
      await persistSessionTranscriptTurn(otherScope, {
        messages: [
          { eventId: `event-${other.key}`, message: { role: "user", content: "Summarize" } },
        ],
        touchSessionEntry: false,
      });
    }
    const preparations: Array<(value: typeof prepared) => void> = [];
    prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          preparations.push(resolve);
        }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      service.ensure(target);
      service.ensure(secondTarget);
      service.ensure(thirdTarget);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(view()?.state).toBe("updating");
      expect(prepare).toHaveBeenCalledTimes(2);
      for (const resolve of preparations) {
        resolve(prepared);
      }
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(3));
      expect(complete).not.toHaveBeenCalled();
      const disposal = service.dispose();
      preparations[2]!(prepared);
      await vi.advanceTimersByTimeAsync(0);
      await disposal;
      expect(complete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a replacement owner's pending status when the old service disposes", async () => {
    await messages(1);
    let finish!: (value: typeof prepared) => void;
    prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    service.ensure(target);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const oldService = service;
    service = createSessionActivitySummaries({
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: async () => prepared,
      completeModel: complete,
    });
    service.ensure(target);
    const oldDisposal = oldService.dispose();
    expect(view()?.state).toBe("updating");
    finish(prepared);
    await oldDisposal;
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("enqueues through the registered RPC handler and rejects an invalid batch before model work", async () => {
    await messages(1);
    cfg.gateway = { controlUi: { sessionObserver: false } };
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      sessionActivitySummaries: service,
    });
    const respond = vi.fn();
    const handler = sessionActivitySummaryHandlers["sessions.activitySummary.ensure"]!;
    const invoke = (params: Record<string, unknown>) =>
      handler({
        req: { type: "req", id: "1", method: "sessions.activitySummary.ensure", params },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
    await invoke({ sessions: [target, { key: "agent:main:missing", agentId: "main" }] });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(prepare).not.toHaveBeenCalled();
    await invoke({ sessions: [target] });
    expect(respond).toHaveBeenLastCalledWith(true, {
      sessions: [{ ...target, activitySummary: { state: "updating", canEnsure: true } }],
    });
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("backfills a cold archived transcript through its restoration owner", async () => {
    await messages(2);
    await replaceSessionEntry(scope, { ...read()!, updatedAt: 1, archivedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_windows")
            .set({ updated_at: 1, transcript_updated_at: 1 })
            .where("session_id", "=", scope.sessionId),
        );
      },
      { agentId: "main" },
    );
    const maintenance: OpenClawConfig = {
      agents: { list: [{ id: "main" }] },
      session: {
        store: database.path,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    expect(await runSessionColdStorageMaintenance({ config: maintenance })).toMatchObject({
      archivedTranscripts: 1,
    });
    expect((await getSessionColdStorageStatus(maintenance))[0]?.coldTranscripts).toBe(1);
    const before = read()?.updatedAt;
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"), { timeout: 5_000 });
    expect(read()?.activitySummary?.coveredMessages).toBe(2);
    expect(read()?.updatedAt).toBe(before);
    expect(read()?.archivedAt).toBe(1);
    expect((await getSessionColdStorageStatus(maintenance))[0]?.coldTranscripts).toBe(0);
  });

  it("normalizes alias ownership in list projection and catches context-only terminal outcomes", async () => {
    const aliasTarget = { key: "agent:main:main", agentId: "main" };
    const aliasScope = { sessionKey: aliasTarget.key, agentId: "main", sessionId: "alias-session" };
    await upsertSessionEntryCore(aliasScope, { sessionId: aliasScope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(aliasScope, {
      messages: [
        { eventId: "alias-request", message: { role: "user", content: "Prepare deployment" } },
      ],
      touchSessionEntry: false,
    });
    let finish!: (value: ReturnType<typeof result>) => void;
    complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    service.handleTranscript({
      sessionKey: "main",
      agentId: "main",
      sessionId: aliasScope.sessionId,
    });
    service.ensure(aliasTarget);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const row = await listSessionFixture({
      cfg,
      storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
      store: { main: loadSessionEntryReadOnly(aliasScope)! },
      fixtureAgentId: "main",
      opts: { includeActivitySummary: true },
    });
    expect(row.sessions[0]?.activitySummary?.state).toBe("updating");
    finish(result("Prepared the deployment."));
    await vi.waitFor(() =>
      expect(loadSessionEntryReadOnly(aliasScope)?.activitySummary).toBeDefined(),
    );
    await persistSessionTranscriptTurn(aliasScope, {
      messages: [
        {
          eventId: "alias-outcome",
          parentId: "alias-request",
          message: {
            role: "assistant",
            content: `Checked build. ${"Detailed output. ".repeat(200)}Waiting for Alex to approve deployment.`,
          },
        },
      ],
      touchSessionEntry: false,
    });
    const before = changed.mock.calls.length;
    for (let index = 0; index < 10; index += 1) {
      service.handleTranscript({
        sessionKey: "main",
        agentId: "main",
        sessionId: aliasScope.sessionId,
      });
    }
    expect(changed.mock.calls.length - before).toBe(1);
    registerAgentRunContext("recap-context-run", {
      sessionKey: "main",
      agentId: "main",
      sessionId: aliasScope.sessionId,
    });
    service.handleEvent({
      runId: "recap-context-run",
      seq: 1,
      ts: Date.now(),
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1]![0].prompt).toContain("Waiting for Alex to approve deployment.");
    expect(complete.mock.calls[1]![0].prompt.length).toBeLessThan(2_000);
  });

  it("projects an identityless pending initialization without failing the Activity list", async () => {
    const key = "agent:main:pending";
    const entry = normalizePersistedSessionEntryShape(
      { sessionId: key, updatedAt: 1 },
      { sessionKey: key },
    );
    expect(entry).toMatchObject({ initializationPending: true });
    expect(entry).not.toHaveProperty("sessionId");
    const listed = await listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [key]: entry! },
      opts: { includeActivitySummary: true },
    });
    expect(listed.sessions[0]?.activitySummary).toEqual({ state: "unavailable" });
  });

  it("does not enqueue model work while trusted session initialization is pending", async () => {
    await messages(1);
    await patchSessionEntryCore(scope, () => ({ initializationPending: true }));
    expect(service.ensure(target)).toEqual({ state: "unavailable" });
    await service.dispose();
    expect(prepare).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("readmits a relocated store and fences a delayed result from its previous owner", async () => {
    await messages(2);
    service.ensure(target);
    await vi.waitFor(() => expect(view()?.state).toBe("current"));
    await messages(1, 2);
    let finishOld!: (value: ReturnType<typeof result>) => void;
    complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    complete.mockImplementationOnce(async () => result("Recap from the relocated store."));
    service.ensure(target);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    const relocatedDirectory = testState.path("relocated");
    await mkdir(relocatedDirectory);
    const relocatedPath = testState.path("relocated", "openclaw-agent.sqlite");
    const originalDatabase = openOpenClawAgentDatabase({ agentId: "main" });
    const originalScope = { ...scope, storePath: originalDatabase.path };
    await backup(originalDatabase.db, relocatedPath);
    cfg = { ...cfg, session: { store: relocatedPath } };
    const relocatedScope = { ...scope, storePath: relocatedPath };
    try {
      const relocatedEntry = loadSessionEntryReadOnly(relocatedScope)!;
      expect(relocatedEntry.sessionId).toBe(scope.sessionId);
      expect(relocatedEntry.lifecycleRevision).toBe(
        loadSessionEntryReadOnly(originalScope)?.lifecycleRevision,
      );
      const projected = projectSessionActivitySummary({ ...target, cfg, entry: relocatedEntry });
      expect.soft(projected?.state).toBe("stale");
      const published = createDeferred<ReturnType<typeof loadSessionEntryReadOnly>>();
      changed.mockImplementation(() => {
        const entry = loadSessionEntryReadOnly(relocatedScope);
        if (projectSessionActivitySummary({ ...target, cfg, entry })?.state !== "updating") {
          published.resolve(entry);
        }
      });
      service.ensure(target);
      expect((await published.promise)?.activitySummary?.coveredMessages).toBe(3);
      expect(loadSessionEntryReadOnly(relocatedScope)?.activitySummary?.text).toBe(
        "Recap from the relocated store.",
      );
      expect(complete.mock.calls[1]![0].abortSignal?.aborted).toBe(true);
    } finally {
      finishOld(result("Outdated store result."));
    }
    await service.dispose();
    expect(loadSessionEntryReadOnly(relocatedScope)?.activitySummary?.text).toBe(
      "Recap from the relocated store.",
    );
    expect(loadSessionEntryReadOnly(originalScope)?.activitySummary?.coveredMessages).toBe(2);
    expect(loadSessionEntryReadOnly(originalScope)?.activitySummary?.text).toBe(
      "Completed the requested work.",
    );
  });

  it("honors disabled utility routing and excludes child and incognito sessions", async () => {
    await messages(1);
    cfg = { agents: { defaults: { utilityModel: "" } } };
    expect(service.ensure(target).state).toBe("unavailable");
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    for (const key of ["agent:main:subagent:child", "agent:main:incognito:private"]) {
      const childScope = { agentId: "main", sessionKey: key, sessionId: key };
      await upsertSessionEntryCore(childScope, { sessionId: key, updatedAt: 1 });
      await persistSessionTranscriptTurn(childScope, {
        messages: [
          { eventId: `event-${key}`, message: { role: "user", content: "Private child work" } },
        ],
        touchSessionEntry: false,
      });
    }
    service.ensure({ key: "agent:main:subagent:child", agentId: "main" });
    service.ensure({ key: "agent:main:incognito:private", agentId: "main" });
    expect(prepare).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
