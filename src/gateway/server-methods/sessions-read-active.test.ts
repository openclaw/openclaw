import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  createReplyOperation,
  markReplyOperationExecutionStarted,
} from "../../auto-reply/reply/reply-run-registry.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEventForRunContext, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { observeSessionRowBackfill } from "../session-row-backfill.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as rowInputs from "../session-utils-row.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  seedSessions,
  seedSessionsWithActivityTimes,
} from "./sessions-read-cache.test-support.js";
import {
  activateReadSession as activate,
  addReadSubagent,
  sessionReader,
} from "./sessions-read-fixture.test-support.js";

const mainKey = "agent:main:active";
const mainId = "main-active";
const agentConfig: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };

async function storeSession(
  agentId: string,
  sessionKey: string,
  entry: Partial<SessionEntry> & Pick<SessionEntry, "sessionId" | "updatedAt">,
  storePath?: string,
) {
  const scope = { agentId, sessionKey, storePath };
  const stored = await upsertSessionEntryCore(scope, { visibility: "shared", ...entry });
  await replaceSessionEntry(scope, { ...stored!, updatedAt: entry.updatedAt });
}

function registerRun(runId: string, agentId: string, sessionKey: string, sessionId: string) {
  registerAgentRunContext(runId, { agentId, sessionKey, sessionId, projectSessionActive: true });
}

const identities = (result: Awaited<ReturnType<typeof listSessions>>) =>
  result.sessions.map((row) => [row.key, row.agentId]);

function startModelRun(
  context: ReturnType<typeof requestContext>,
  runId: string,
  model?: "current" | "attempt",
  sessionKey = mainKey,
) {
  registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    agentId: "main",
    sessionKey: mainKey,
    sessionId: mainId,
    timeoutMs: 60_000,
  });
  if (!model) {
    return;
  }
  registerRun(runId, "main", sessionKey, mainId);
  emitAgentEventForRunContext(
    {
      runId,
      stream: "lifecycle",
      data: { phase: "model", provider: `${model}-provider`, model: `${model}-model` },
    },
    getAgentRunContext(runId)!,
  );
}
async function changeDuringReadiness(
  context: ReturnType<typeof requestContext>,
  change: () => void | Promise<void>,
) {
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  const ensure = projection.prepareSelection.bind(projection);
  return vi.spyOn(projection, "prepareSelection").mockImplementationOnce(async (...args) => {
    await change();
    await ensure(...args);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await resetSubagentRegistryForTests({ persist: false });
  resetAgentEventsForTest();
});

it("selects current work before pagination and represents an isolated cron run once", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = agentConfig;
    setRuntimeConfigSnapshot(config);
    const { context, list } = sessionReader(config, "viewer@example.test");
    const childKey = "agent:main:subagent:child";
    const cronKey = "agent:main:cron:daily";
    const runKey = `${cronKey}:run:cron-session`;
    const recent = Date.now() - 1_000;
    for (const [agentId, sessionKey, sessionId, updatedAt] of [
      ["main", "agent:main:local", "local-session", 40],
      ["work", "agent:work:remote", "remote-session", 30],
      ["main", childKey, "child-session", 20],
      ["main", cronKey, "cron-session", 10],
      ["main", runKey, "cron-session", 10],
      ["main", "agent:main:parent", "parent-session", 100],
      ["main", "agent:main:hidden", "hidden-session", 101],
      ["main", "agent:main:settled", "settled-session", 102],
      ["main", "agent:main:stale-status", "stale-session", 103],
    ] as const) {
      await storeSession(agentId, sessionKey, { sessionId, updatedAt: recent + updatedAt });
    }
    activate(context, "local-run", "main", "agent:main:local", "local-session");
    context.chatAbortControllers.set("hidden-run", {
      sessionKey: "agent:main:hidden",
      controlUiVisible: false,
    } as never);
    context.chatAbortControllers.set("settled-run", {
      sessionKey: "agent:main:settled",
      projectSessionActive: false,
    } as never);
    registerAgentRunContext("remote-run", {
      agentId: "work",
      sessionKey: "agent:work:remote",
      sessionId: "remote-session",
      projectSessionActive: true,
      isControlUiVisible: false,
    });
    registerRun("cron-run", "main", runKey, "cron-session");
    await addReadSubagent("child-run", childKey, "agent:main:parent", {
      requesterDisplayKey: "parent",
    });
    const childClaim = claimAgentRunContext(
      "child-run",
      { sessionKey: childKey, agentId: "main" },
      { trackOwner: true, ownsContext: true },
    );
    const releaseWait = registerAgentRunCapacityWait("child-run", getAgentRunLifecycleGeneration());
    try {
      expect(childClaim).toBeDefined();
      const normal = await list({ limit: 2 });
      expect(normal.sessions.map((row) => row.key)).toEqual([
        "agent:main:stale-status",
        "agent:main:settled",
      ]);
      const unchanged = await list({ activeOnly: false, limit: 2 });
      expect(unchanged.sessions.map((row) => row.key)).toEqual(
        normal.sessions.map((row) => row.key),
      );

      const request = { activeOnly: true, limit: 2 };
      const first = await list(request);
      expect(first).toMatchObject({
        count: 2,
        totalCount: 4,
        nextOffset: 2,
        sessions: [
          {
            key: "agent:main:local",
            hasActiveRun: true,
            status: "running",
            activeRunIds: ["local-run"],
          },
          { key: "agent:work:remote", hasActiveRun: true, status: "running" },
        ],
      });
      expect(first.sessions[1]).not.toHaveProperty("activeRunIds");
      const second = await list({ ...request, offset: 2 });
      expect(second).toMatchObject({ count: 2, totalCount: 4, nextOffset: null });
      expect(second.sessions).toMatchObject([
        { key: childKey, hasActiveRun: true, status: "queued" },
        { key: cronKey, hasActiveRun: true, status: "running" },
      ]);
    } finally {
      releaseWait?.();
      releaseAgentRunContext("child-run", childClaim);
      for (const runId of ["remote-run", "cron-run", "child-run"]) {
        clearAgentRunContext(runId);
      }
    }
  }));

it.each(["global", "unknown"] as const)(
  "keeps %s activity with its agent when physical stores share a session ID",
  (sessionKey) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {}, ops: {} } },
        session: { scope: "global", store: state.statePath("{agentId}.sqlite") },
      };
      setRuntimeConfigSnapshot(config);
      const sessionId = `restored-${sessionKey}`;
      const runId = `ops-${sessionKey}-run`;
      for (const agentId of ["main", "ops"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey, storePath: state.statePath(`${agentId}.sqlite`) },
          { sessionId, updatedAt: 1, visibility: "shared" },
        );
      }
      const { list } = sessionReader(config, "viewer@example.test");
      const request = { activeOnly: true, includeGlobal: true, includeUnknown: true, limit: 100 };
      const activeOwners = async () => (await list(request)).sessions.map((row) => row.agentId);
      const handle: EmbeddedAgentQueueHandle = {
        runId,
        abort: () => undefined,
        isAborted: () => false,
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => undefined,
      };
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      registerRun(runId, "ops", sessionKey, sessionId);
      try {
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "ops");
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        clearAgentRunContext(runId);
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);

        reply = createReplyOperation({
          agentId: "ops",
          sessionId,
          sessionKey,
          resetTriggered: false,
        });
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        markReplyOperationExecutionStarted(reply);
        await expect(activeOwners()).resolves.toEqual(["ops"]);
        reply.complete();
        await expect(activeOwners()).resolves.toEqual([]);
      } finally {
        reply?.complete();
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        clearAgentRunContext(runId);
      }
    }),
);

it.for(["global", "unknown"] as const)(
  "keeps active %s owners and their physical transcript, board, and sharing rows distinct",
  (sentinel, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const now = Date.now();
      const agents = ["main", "ops", "research", "private"] as const;
      const config: OpenClawConfig = {
        session: { scope: "global", store: state.statePath("{agentId}.sqlite") },
        agents: { entries: Object.fromEntries(agents.map((id) => [id, {}])) },
      };
      setRuntimeConfigSnapshot(config);
      const { context, list } = sessionReader(config, "viewer@example.test");
      const storePathFor = (agentId: string) => state.statePath(`${agentId}.sqlite`);
      const boardFace = "chat" as const;
      for (const [index, agentId] of agents.entries()) {
        const sessionId = `${sentinel}-${agentId}`;
        const storePath = storePathFor(agentId);
        openOpenClawAgentDatabase({ agentId, path: storePath });
        await storeSession(
          agentId,
          sentinel,
          {
            sessionId,
            boardFace,
            updatedAt: now - index,
            displayName: `${agentId.charAt(0).toUpperCase()}${agentId.slice(1)} task`,
            visibility: agentId === "private" ? "draft" : "shared",
            createdActor: { type: "human", source: "profile", id: "owner@example.test" },
          },
          storePath,
        );
        await persistSessionTranscriptTurn(
          { agentId, storePath, sessionKey: sentinel, sessionId },
          {
            messages: [
              { message: { role: "user", content: `${agentId} task` } },
              { message: { role: "assistant", content: `${agentId} progress` } },
            ],
            touchSessionEntry: false,
          },
        );
        if (agentId !== "main") {
          activate(context, `sentinel-run-${agentId}`, agentId, sentinel, sessionId);
        }
      }
      const childKey = `agent:ops:subagent:${sentinel}-child`;
      await upsertSessionEntryCore(
        { agentId: "ops", storePath: storePathFor("ops"), sessionKey: childKey },
        {
          sessionId: "sentinel-child",
          updatedAt: now - 100,
          parentSessionKey: sentinel,
          spawnedBy: sentinel,
          visibility: "shared",
        },
      );
      await addReadSubagent("sentinel-child-run", childKey, sentinel, {
        requesterAgentId: "ops",
        swarmRequesterSessionKey: sentinel,
        collect: true,
        groupId: "ops-group",
      });
      registerAgentRunContext("sentinel-child-run", { sessionKey: childKey, agentId: "ops" });
      const literalKey = `agent:ops:${sentinel}`;
      const literalSessionId = `literal-${sentinel}`;
      await storeSession(
        "ops",
        literalKey,
        {
          sessionId: literalSessionId,
          boardFace,
          updatedAt: now - 100,
          visibility: "shared",
        },
        storePathFor("ops"),
      );
      activate(context, "literal-sentinel-run", "ops", literalKey, literalSessionId);
      await new SqliteBoardStore({
        resolveSession: () => ({ agentId: "ops", path: storePathFor("ops"), sessionKey: sentinel }),
      }).applyOps({ sessionKey: sentinel }, [{ kind: "tab_create", tabId: "main", title: "Ops" }]);
      const backfilled = observeSessionRowBackfill(
        ["ops", "research"].map((agentId) =>
          JSON.stringify([agentId, storePathFor(agentId), sentinel]),
        ),
        undefined,
        (row) => JSON.stringify([row.agentId, row.storeTarget.storePath, row.key]),
      );
      const normal = await list({ boardFace, includeGlobal: true, includeUnknown: true });
      expect(normal.sessions).toMatchObject([
        { key: sentinel, agentId: "main", hasActiveRun: false },
        { key: literalKey, agentId: "ops", kind: "direct", hasActiveRun: true },
      ]);
      expect(normal.count).toBe(2);

      const request = {
        activeOnly: true,
        boardFace,
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
        archived: "all" as const,
        limit: 10,
      };
      await withinTest(backfilled, signal);
      const active = await list(request);
      expect(active).toMatchObject({
        count: 3,
        totalCount: 3,
        nextOffset: null,
        sessions: [
          ...["ops", "research"].map((agentId) => ({
            key: sentinel,
            agentId,
            kind: sentinel,
            boardFace,
            hasActiveRun: true,
            derivedTitle: `${agentId === "ops" ? "Ops" : "Research"} task`,
            lastMessagePreview: `${agentId} progress`,
          })),
          {
            key: literalKey,
            agentId: "ops",
            kind: "direct",
            sessionId: literalSessionId,
            hasActiveRun: true,
          },
        ],
      });
      expect(JSON.stringify(active)).not.toContain(`${sentinel}-private`);
      for (const row of active.sessions.filter((candidate) => candidate.key === sentinel)) {
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Assert the serialized wire shape.
        const wireRow: unknown = JSON.parse(JSON.stringify(row));
        expect(wireRow).not.toHaveProperty("childSessions");
        expect(wireRow).not.toHaveProperty("hasActiveSubagentRun");
      }
      expect(active.sessions[0]?.swarm?.groups).toMatchObject([
        { groupId: "ops-group", running: 1 },
      ]);
      expect(active.sessions[1]?.swarm).toBeUndefined();
      const scoped = await list({ ...request, agentId: "ops" });
      expect(identities(scoped)).toEqual([
        [sentinel, "ops"],
        [literalKey, "ops"],
      ]);
      const excluded = sentinel === "global" ? { includeGlobal: false } : { includeUnknown: false };
      for (const filter of [{ search: "direct" }, excluded]) {
        const literalOnly = await list({ ...request, ...filter });
        expect(literalOnly.sessions).toMatchObject([
          { key: literalKey, agentId: "ops", kind: "direct", sessionId: literalSessionId },
        ]);
        expect(literalOnly.count).toBe(1);
      }
      for (const hasBoard of [true, false]) {
        const listed = await list({ ...request, hasBoard });
        expect(identities(listed)).toEqual(
          hasBoard
            ? [[sentinel, "ops"]]
            : [
                [sentinel, "research"],
                [literalKey, "ops"],
              ],
        );
      }

      const readiness = await changeDuringReadiness(context, async () => {
        await upsertSessionEntryCore(
          { agentId: "ops", storePath: storePathFor("ops"), sessionKey: sentinel },
          { visibility: "draft" },
        );
      });
      const restricted = await list(request);
      expect(readiness).toHaveBeenCalled();
      expect(identities(restricted)).toEqual([
        [sentinel, "research"],
        [literalKey, "ops"],
      ]);
      expect(restricted).toMatchObject({ count: 2, totalCount: 2 });
      clearAgentRunContext("sentinel-child-run");
    }),
);

it.each([{ activeMinutes: 1 }, { activeOnly: true }])(
  "reuses resident rows across concurrent filtered requests: %j",
  (filter: SessionsListParams) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { clock, config } = await seedSessionsWithActivityTimes();
      const context = requestContext(config);
      activate(context, "active-run", "main", "agent:main:active", "main-active");
      const client = identifiedClient("owner@example.com");
      clock.mockReturnValue(60_400);
      const request = { ...filter, agentId: "main", limit: 100 };

      await initializeSessionReadContext(context);
      await listSessions({ client, context, request });
      const reads = vi.spyOn(rowInputs, "readSessionRowInputs");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => listSessions({ client, context, request })),
      );

      expect(results[0]?.sessions.map((session) => session.key)).toEqual(["agent:main:active"]);
      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
      expect(reads).not.toHaveBeenCalled();
    }),
);

it.each(["settled", "replaced"] as const)(
  "refills active work after the selected run is %s during projection",
  (transition) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const { context, list } = sessionReader(config, "viewer@example.com");
      for (const agentId of ["main", "work"]) {
        const scope = { agentId, sessionKey: `agent:${agentId}:active` };
        const entry = loadSessionEntry(scope);
        if (!entry) {
          throw new Error("Missing seeded active session");
        }
        await replaceSessionEntry(scope, { ...entry, updatedAt: agentId === "main" ? 400 : 100 });
        activate(context, `run-${agentId}`, agentId, scope.sessionKey, `${agentId}-active`);
      }
      const readiness = await changeDuringReadiness(context, async () => {
        context.chatAbortControllers.delete("run-main");
        if (transition === "replaced") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:active" },
            { sessionId: "replacement-session" },
          );
          activate(context, "run-replacement", "main", "agent:main:active", "replacement-session");
        }
      });
      const request = { activeOnly: true, limit: 1 };
      const result = await list(request);
      expect(readiness).toHaveBeenCalled();
      expect(result.sessions).toMatchObject([
        transition === "replaced"
          ? { key: "agent:main:active", sessionId: "replacement-session", hasActiveRun: true }
          : { key: "agent:work:active", sessionId: "work-active", hasActiveRun: true },
      ]);
      expect(result).toMatchObject({
        count: 1,
        totalCount: transition === "replaced" ? 2 : 1,
        nextOffset: transition === "replaced" ? 1 : null,
      });
    }),
);

it.each([false, true])(
  "refreshes the active model across aliased keys after list projection yields (known=%s)",
  (known) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const { context, list } = sessionReader(config, "viewer@example.com");
      const sessionKey = "agent:main:active";
      const runId = "new-model-run";
      const readiness = await changeDuringReadiness(context, () => {
        startModelRun(context, runId, known ? "current" : undefined, "agent:main:requested");
      });
      const result = await list({ agentId: "main", activeOnly: true, limit: 100 });
      expect(readiness).toHaveBeenCalled();
      const row = result.sessions.find((session) => session.key === sessionKey);
      expect(row).toMatchObject({ hasActiveRun: true });
      expect([row?.activeModelProvider, row?.activeModel]).toEqual(
        known ? ["current-provider", "current-model"] : [undefined, undefined],
      );
    }),
);

it.each(
  (["configured", "inherited"] as const).flatMap((selection) =>
    (["done", undefined] as const).map((storedStatus) => ({ selection, storedStatus })),
  ),
)(
  "reconciles a completed fallback during projection ($selection selection, $storedStatus status)",
  ({ selection, storedStatus }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: {
          model: {
            primary:
              selection === "inherited"
                ? "default-provider/default-model"
                : "selected-provider/selected-model",
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const { context, list } = sessionReader(config, "viewer@example.com");
      const sessionKey = "agent:main:active";
      const runId = "settling-model-run";
      if (selection === "inherited") {
        config.session = { ...config.session, scope: "global" };
        await upsertSessionEntryCore(
          { agentId: "work", sessionKey: "agent:work:main" },
          {
            sessionId: "work-parent",
            providerOverride: "selected-provider",
            modelOverride: "selected-model",
            modelOverrideSource: "user",
            modelOverrideRouteResolution: "resolved",
          },
        );
        const scope = { agentId: "main", sessionKey };
        const entry = expectDefined(loadSessionEntry(scope), "child session");
        await replaceSessionEntry(scope, { ...entry, parentSessionKey: "agent:work:main" });
      }
      startModelRun(context, runId, "attempt");

      const readiness = await changeDuringReadiness(context, async () => {
        context.chatAbortControllers.delete(runId);
        clearAgentRunContext(runId);
        const scope = { agentId: "main", sessionKey };
        const entry = expectDefined(loadSessionEntry(scope), "settling session");
        await replaceSessionEntry(scope, {
          ...entry,
          status: storedStatus,
          lastRunId: runId,
          modelProvider: "fallback-provider",
          model: "fallback-model",
          fallbackNotice: {
            kind: "active",
            selectedModel: "selected-provider/selected-model",
            activeModel: "fallback-provider/fallback-model",
          },
        });
      });

      const result = await list({ agentId: "main", limit: 100 });
      expect(readiness).toHaveBeenCalled();
      expect(result.sessions.find((session) => session.key === sessionKey)).toMatchObject({
        hasActiveRun: false,
        activeModelProvider: "fallback-provider",
        activeModel: "fallback-model",
      });
    }),
);
