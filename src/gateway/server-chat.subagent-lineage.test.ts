import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { emitAgentEvent } from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

function createLineageHarness(projection: SessionRowProjection, key: string) {
  const broadcast = vi.fn();
  const chatRunState = createChatRunState();
  const runId = "prepared-lineage-run";
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => key,
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    getSessionRowProjection: () => projection,
  });
  let seq = 0;
  return {
    expectLineage(expected: string | undefined) {
      broadcast.mockClear();
      const materialized = projection.materializedCount;
      const sql = observeHostDataSql();
      const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
      try {
        const stream = seq === 0 ? "assistant" : "thinking";
        emitAgentEvent(handler, runId, stream, { text: "Prepared child response" }, { seq: ++seq });
        const payload = broadcast.mock.calls.find(
          ([event]) => event === (stream === "assistant" ? "chat" : "agent"),
        )?.[1];
        expect(payload).toMatchObject({ sessionKey: key });
        if (expected === undefined) {
          expect.soft(payload).not.toHaveProperty("spawnedBy");
        } else {
          expect.soft(payload).toHaveProperty("spawnedBy", expected);
        }
        expect.soft(sql.queries).toEqual([]);
        expect(projection.materializedCount).toBe(materialized);
        expect(builds).not.toHaveBeenCalled();
      } finally {
        builds.mockRestore();
        sql.restore();
      }
    },
    dispose() {
      handler.dispose();
      chatRunState.clear();
    },
  };
}

it("keeps prepared lineage current across publications and store lifetimes without SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", mainKey: "dashboard:lineage-alias" },
    };
    setRuntimeConfigSnapshot(cfg);
    // New keys can publish prepared metadata after their physical store is admitted.
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:lineage-anchor" },
      { sessionId: "lineage-anchor", updatedAt: 1 },
    );
    const key = "agent:main:subagent:prepared-lineage";
    const target = { agentId: "main", sessionKey: key };
    const controller = "agent:main:controller";
    const replacement = "agent:main:replacement-controller";
    const runId = "prepared-lineage-run";
    const fallback = "agent:main:former-controller";
    const entry = { sessionId: "lineage", updatedAt: 1, spawnedBy: fallback };
    const run = createSubagentRunRecord({
      runId,
      childSessionKey: key,
      requesterSessionKey: controller,
      controllerSessionKey: controller,
    });
    subagentRuns.set(runId, run);
    publishSubagentRunChanges([key]);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const harnesses: ReturnType<typeof createLineageHarness>[] = [];
    const child = createLineageHarness(projection, key);
    harnesses.push(child);
    try {
      child.expectLineage(undefined);
      replaceSessionEntrySync(target, entry);
      publishSubagentRunChanges([key]);
      child.expectLineage(fallback);
      await projection.ensureMaterialized();
      child.expectLineage(controller);
      subagentRuns.set(runId, { ...run, controllerSessionKey: replacement });
      publishSubagentRunChanges([key]);
      child.expectLineage(fallback);
      await projection.ensureMaterialized();
      child.expectLineage(replacement);
      await deleteSessionEntryLifecycle({
        ...target,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      await projection.ensureMaterialized();
      child.expectLineage(undefined);
      subagentRuns.delete(runId);
      publishSubagentRunChanges([key]);

      for (const kind of ["dashboard", "acp", "archived", "incognito"] as const) {
        const incognito = kind === "incognito";
        const sessionKey = `agent:main:${kind === "acp" ? "acp" : "dashboard"}:${incognito ? "incognito-" : ""}lineage-${kind}`;
        const scope = { agentId: "main", sessionKey };
        const parent = "agent:main:main";
        const stored = {
          sessionId: `stored-lineage-${kind}`,
          updatedAt: 1,
          spawnedBy: parent,
          ...(kind === "archived" ? { archivedAt: 1 } : {}),
          ...(incognito ? { incognito: true as const } : {}),
        };
        replaceSessionEntrySync(scope, stored);
        await projection.ensureMaterialized();
        const eventKey = incognito
          ? sessionKey.replace("agent:main:", "AGENT:MAIN:")
          : kind === "acp"
            ? sessionKey.slice("agent:main:".length)
            : sessionKey;
        const harness = createLineageHarness(projection, eventKey);
        harnesses.push(harness);
        harness.expectLineage(parent);
        replaceSessionEntrySync(scope, {
          ...stored,
          sessionId: `replacement-${kind}`,
          updatedAt: 2,
          spawnedBy: "agent:main:new-parent",
        });
        harness.expectLineage("agent:main:new-parent");
        if (incognito) {
          expect(
            closeOpenClawAgentDatabaseByPath(
              resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            ),
          ).toBe(true);
          harness.expectLineage(undefined);
        }
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "lineage-alias", updatedAt: 1, spawnedBy: fallback },
      );
      subagentRuns.set(runId, { ...run, childSessionKey: "global" });
      publishSubagentRunChanges(["global"]);
      await projection.ensureMaterialized();
      const alias = createLineageHarness(projection, "agent:main:dashboard:lineage-alias");
      harnesses.push(alias);
      alias.expectLineage(controller);
      projection.dispose();
      for (const harness of harnesses) {
        harness.expectLineage(undefined);
      }
    } finally {
      for (const harness of harnesses) {
        harness.dispose();
      }
      projection.dispose();
      subagentRuns.delete(runId);
      publishSubagentRunChanges([key, "global"]);
    }
  });
});
