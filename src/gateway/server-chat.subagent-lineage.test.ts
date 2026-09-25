import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { emitAgentEvent } from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it.each([
  { name: "stored session", stored: true, dirty: false },
  { name: "missing session", stored: false, dirty: false },
  { name: "unprepared metadata", stored: true, dirty: true },
])("uses only prepared lineage during ingestion with $name", async ({ stored, dirty }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:subagent:prepared-lineage";
    const controller = "agent:main:controller";
    const runId = "prepared-lineage-run";
    const fallback = "agent:main:former-controller";
    if (stored) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "lineage", updatedAt: 1, spawnedBy: fallback },
      );
    }
    subagentRuns.set(
      runId,
      createSubagentRunRecord({
        runId,
        childSessionKey: key,
        requesterSessionKey: controller,
        controllerSessionKey: controller,
      }),
    );
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    if (dirty) {
      publishSubagentRunChanges([key]);
    }
    const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
    const broadcast = vi.fn();
    const chatRunState = createChatRunState();
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
    try {
      if (dirty) {
        expect(projection.readPreparedRowContext()).toBeUndefined();
      } else {
        expect(projection.readPreparedRowContext()).toBeDefined();
      }
      emitAgentEvent(handler, runId, "assistant", { text: "Prepared child response" });
      const chat = broadcast.mock.calls.find(([event]) => event === "chat")?.[1];
      expect(chat).toMatchObject({ sessionKey: key });
      if (stored) {
        expect(chat).toHaveProperty("spawnedBy", dirty ? fallback : controller);
      } else {
        expect(chat).not.toHaveProperty("spawnedBy");
      }
      expect(builds).not.toHaveBeenCalled();
      if (dirty) {
        await projection.ensureMaterialized();
        builds.mockClear();
        broadcast.mockClear();
        emitAgentEvent(
          handler,
          runId,
          "thinking",
          { text: "Prepared lineage resumed" },
          { seq: 2 },
        );
        expect(broadcast.mock.calls.find(([event]) => event === "agent")?.[1]).toMatchObject({
          sessionKey: key,
          spawnedBy: controller,
        });
        expect(builds).not.toHaveBeenCalled();
      }
    } finally {
      builds.mockRestore();
      handler.dispose();
      chatRunState.clear();
      projection.dispose();
      subagentRuns.delete(runId);
    }
  });
});
