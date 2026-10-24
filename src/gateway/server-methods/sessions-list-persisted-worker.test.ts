import { expect, it } from "vitest";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import { persistRegistryFixture } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { createEmbeddedCallGateway } from "../../agents/tools/embedded-gateway-stub.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  lookupPluginStateInWorker,
  registerPluginStateInWorker,
} from "../../plugin-state/plugin-state-worker-client.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { EmbeddedTuiBackend } from "../../tui/embedded-backend.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { sessionReader } from "./sessions-keyed-read.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

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
const controller = "agent:main:controller";
const mainConfig = () => ({ agents: { entries: { main: {} } } });
const writeSession = (sessionKey: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
  upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
const group = { groupId: "retained-group", done: 1 };
const childLinks = {
  childSessions: ["agent:main:subagent:child"],
  swarm: { groups: [{ ...group, failed: 0 }] },
};
const controllerRow = { key: controller, ...childLinks };
const withRunState = (consume: () => Promise<void>) =>
  withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    consume,
  );

function linkedRuns() {
  return [
    run("child", { requesterSessionKey: "agent:main:requester", controllerSessionKey: controller }),
    run("deleted", {
      collect: true,
      groupId: "retained-group",
      swarmRequesterSessionKey: controller,
      collectorCompletion: { status: "done" },
    }),
  ] as const;
}
it.each(["replaced", "made private"])(
  "describes current session metadata without waiting for catalog readiness when the session is %s",
  async (change) => {
    await withRunState(async () => {
      const reader: GatewayOperatorRoleDefinition = {
        agents: "*" as const,
        scopes: ["operator.read"],
        sessions: { others: "view" as const },
      };
      const cfg: OpenClawConfig = {
        ...mainConfig(),
        gateway: { roles: { default: "reader", definitions: { reader } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      const viewerId = ensureProfileForEmail("viewer@example.com").id;
      await writeSession(controller, {
        sessionId: "original-session",
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      const [child, collector] = linkedRuns();
      await writeSession(child.childSessionKey, {
        sessionId: "child-session",
        updatedAt: Date.now(),
        visibility: "shared",
      });
      persistRegistryFixture(new Map([child, collector].map((entry) => [entry.runId, entry])));
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
      try {
        await reading.promise;
        await writeSession(
          controller,
          change === "replaced"
            ? { sessionId: "replacement-session", label: "Current conversation" }
            : { visibility: "draft" },
        );
        // Row workers may yield; the unrelated catalog renewal stays held until cleanup.
        const result = await sessionReader(context, identifiedClient(viewerId), controller)();
        if (change === "made private") {
          expect(result).toEqual({ session: null });
        } else {
          expect(result).toMatchObject({
            session: {
              sessionId: "replacement-session",
              displayName: "Current conversation",
              ...childLinks,
            },
          });
          expect(JSON.stringify(result)).not.toContain("retained synthetic");
        }
      } finally {
        catalog.resolve();
        await Promise.allSettled([projection.ensureMaterialized()]);
        projection.dispose();
        clearSubagentRunsReadCacheForTest();
      }
    });
  },
);

it("lists off-page controller links and deleted-collector totals while a sibling worker write settles", async () => {
  await withRunState(async () => {
    clearSubagentRunsReadCacheForTest();
    const cfg = {
      ...mainConfig(),
      // Session reads need the real embedded host, but no bundled plugin runtimes.
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const requester = "agent:main:requester";
    const [child, collector] = linkedRuns();
    for (const [key, updatedAt, spawnedBy] of [
      [requester, 100, undefined],
      [child.childSessionKey, 200, requester],
      [controller, 300, undefined],
    ] as const) {
      await writeSession(key, { sessionId: key, updatedAt, visibility: "shared", spawnedBy });
    }
    persistRegistryFixture(new Map([child, collector].map((entry) => [entry.runId, entry])));
    const key = { pluginId: "session-list-proof", namespace: "mixed-progress", key: "written" };
    const context = requestContext(cfg);
    await initializeSessionReadContext(context);
    try {
      const [result] = await Promise.all([
        listSessions({
          client: identifiedClient("owner@example.com"),
          context,
          request: { limit: 1 },
        }),
        registerPluginStateInWorker({
          ...key,
          valueJson: "true",
          maxEntries: 4,
          overflowPolicy: "reject-new",
        }),
      ]);
      expect(result).toMatchObject({
        count: 1,
        totalCount: 3,
        nextOffset: 1,
        sessions: [controllerRow],
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
            sessions: [{ ...controllerRow, swarm: { groups: [group] } }],
          });
        }
      } finally {
        await backend.stop();
      }
      expect(await lookupPluginStateInWorker(key)).toBe(true);
    } finally {
      getSessionRowProjection(context)?.dispose();
      clearSubagentRunsReadCacheForTest();
    }
  });
});
