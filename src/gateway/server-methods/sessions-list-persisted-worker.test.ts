import { expect, it, vi } from "vitest";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { createEmbeddedCallGateway } from "../../agents/tools/embedded-gateway-stub.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { EmbeddedTuiBackend } from "../../tui/embedded-backend.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:controller",
    requesterAgentId: "main",
    requesterDisplayKey: "controller",
    task: "retained synthetic task",
    cleanup: "keep",
    createdAt: now - 100,
    execution: { status: "terminal", startedAt: now - 90, endedAt: now - 10 },
    completion: { required: false, resultText: "retained synthetic result" },
    delivery: { status: "not_required" },
    ...overrides,
  };
}
it.each(["replaced", "made private"])(
  "describes current session metadata without waiting for catalog readiness when the session is %s",
  async (change) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg: OpenClawConfig = {
          agents: { list: [{ id: "main", default: true }] },
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const controller = "agent:main:controller";
        const ownerId = ensureProfileForEmail("owner@example.com").id;
        const viewerId = ensureProfileForEmail("viewer@example.com").id;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: controller },
          {
            sessionId: "original-session",
            updatedAt: Date.now(),
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: ownerId },
          },
        );
        const child = run("child", {
          requesterSessionKey: "agent:main:requester",
          controllerSessionKey: controller,
        });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: child.childSessionKey },
          { sessionId: "child-session", updatedAt: Date.now(), visibility: "shared" },
        );
        const collector = run("deleted", {
          collect: true,
          groupId: "retained-group",
          swarmRequesterSessionKey: controller,
          collectorCompletion: { status: "done" },
        });
        persistSubagentRunsToDiskOrThrow(
          new Map([child, collector].map((entry) => [entry.runId, entry])),
        );
        clearSubagentRunsReadCacheForTest();
        const context = requestContext(cfg);
        await initializeSessionReadContext(context);
        const projection = getSessionRowProjection(context)!;
        await projection.ensureMaterialized();
        const catalog = createDeferredCore();
        const reading = createDeferredCore();
        context.readPreparedGatewayModelCatalog = async () => {
          reading.resolve();
          await catalog.promise;
          return undefined;
        };
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
        const respond = vi.fn<RespondFn>();
        let request: Promise<void> | void = undefined;
        try {
          await reading.promise;
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: controller },
            change === "replaced"
              ? { sessionId: "replacement-session", label: "Current conversation" }
              : { visibility: "draft" },
          );
          request = sessionByKeyReadHandlers["sessions.describe"]!({
            req: { type: "req", id: "describe-projection", method: "sessions.describe" },
            params: { key: controller },
            client: identifiedClient(viewerId),
            context,
            isWebchatConnect: () => false,
            respond,
          });
          expect(respond).toHaveBeenCalledTimes(1);
          await request;
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          const result = respond.mock.calls[0]?.[1];
          if (change === "made private") {
            expect(result).toEqual({ session: null });
          } else {
            expect(result).toMatchObject({
              session: {
                sessionId: "replacement-session",
                displayName: "Current conversation",
                childSessions: [child.childSessionKey],
                swarm: { groups: [{ groupId: "retained-group", done: 1, failed: 0 }] },
              },
            });
            expect(JSON.stringify(result)).not.toContain("retained synthetic");
          }
        } finally {
          vi.restoreAllMocks();
          catalog.resolve();
          await Promise.allSettled([request, projection.ensureMaterialized()]);
          projection.dispose();
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);

it("lists off-page controller links and deleted-collector totals while a sibling worker write settles", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      clearSubagentRunsReadCacheForTest();
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      setRuntimeConfigSnapshot(cfg);
      const controller = "agent:main:controller";
      const requester = "agent:main:requester";
      const child = run("child", {
        requesterSessionKey: requester,
        controllerSessionKey: controller,
      });
      const collector = run("deleted", {
        collect: true,
        groupId: "retained-group",
        swarmRequesterSessionKey: controller,
        collectorCompletion: { status: "done" },
      });
      for (const [key, updatedAt, spawnedBy] of [
        [requester, 100, undefined],
        [child.childSessionKey, 200, requester],
        [controller, 300, undefined],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { sessionId: key, updatedAt, visibility: "shared", spawnedBy },
        );
      }
      persistSubagentRunsToDiskOrThrow(
        new Map([child, collector].map((entry) => [entry.runId, entry])),
      );
      const key = { pluginId: "session-list-proof", namespace: "mixed-progress", key: "written" };
      const context = requestContext(cfg);
      await initializeSessionReadContext(context);
      try {
        const [result, written] = await Promise.all([
          listSessions({
            client: identifiedClient("owner@example.com"),
            context,
            request: { limit: 1 },
          }),
          runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (worker) =>
            worker.execute({
              type: "pluginState.register",
              input: {
                ...key,
                valueJson: "true",
                maxEntries: 4,
                overflowPolicy: "reject-new",
              },
            }),
          ),
        ]);
        expect(written).toEqual({ ok: true, value: undefined });
        expect(result).toMatchObject({
          count: 1,
          totalCount: 3,
          nextOffset: 1,
          sessions: [
            {
              key: controller,
              childSessions: [child.childSessionKey],
              swarm: { groups: [{ groupId: "retained-group", done: 1, failed: 0 }] },
            },
          ],
        });
        expect(JSON.stringify(result)).not.toContain("retained synthetic");
        const backend = new EmbeddedTuiBackend();
        backend.start();
        try {
          for (const list of [
            () => createEmbeddedCallGateway()({ method: "sessions.list", params: { limit: 1 } }),
            () => backend.listSessions({ limit: 1 }),
          ]) {
            clearSubagentRunsReadCacheForTest();
            expect(await list()).toMatchObject({
              sessions: [
                {
                  key: controller,
                  childSessions: [child.childSessionKey],
                  swarm: { groups: [{ groupId: "retained-group", done: 1 }] },
                },
              ],
            });
          }
        } finally {
          await backend.stop();
        }
        expect(
          await runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (worker) =>
            worker.execute({ type: "pluginState.lookup", input: key }),
          ),
        ).toEqual({ ok: true, value: true });
      } finally {
        getSessionRowProjection(context)?.dispose();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});
