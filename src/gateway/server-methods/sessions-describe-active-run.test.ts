import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

it.each(["chat", "projected"] as const)(
  "describes current %s activity consistently with the roster, independently of the goal",
  async (owner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const key = "agent:main:active";
      const runId = `describe-${owner}-run`;
      const sessionId = "main-active";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          status: "done",
          goal: {
            schemaVersion: 1,
            id: "active-goal",
            objective: "Finish the task",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      );
      await initializeSessionReadContext(context);
      const describe = async () => {
        const responses: Parameters<RespondFn>[] = [];
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "describe-activity", method: "sessions.describe" },
          params: { key },
          context,
          client,
          isWebchatConnect: () => false,
          respond: (...response) => responses.push(response),
        });
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        return responses[0]?.[1];
      };
      const assertActivity = async (
        status: "queued" | "running" | "done",
        hasActiveRun: boolean,
      ) => {
        const expected = {
          key,
          status,
          hasActiveRun,
          ...(owner === "chat" || !hasActiveRun
            ? { activeRunIds: hasActiveRun ? [runId] : [] }
            : {}),
        };
        const described = await describe();
        expect(described).toMatchObject({ session: expected });
        const roster = await listSessions({ context, client, request: { search: key } });
        expect(roster.sessions).toEqual([expect.objectContaining(expected)]);
        if (owner === "projected" && hasActiveRun) {
          expect(described).not.toHaveProperty("session.activeRunIds");
          expect(roster.sessions[0]).not.toHaveProperty("activeRunIds");
        }
      };
      const chat =
        owner === "chat"
          ? registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionId,
              sessionKey: key,
              agentId: "main",
              timeoutMs: 60_000,
              kind: "agent",
            })
          : undefined;
      registerAgentRunContext(runId, {
        sessionId,
        sessionKey: key,
        agentId: "main",
        ...(owner === "projected" ? { projectSessionActive: true } : {}),
      });
      const releaseCapacityWait = registerAgentRunCapacityWait(
        runId,
        getAgentRunLifecycleGeneration(),
      );
      try {
        await assertActivity("queued", true);
        releaseCapacityWait?.();
        await assertActivity("running", true);
        chat?.cleanup();
        clearAgentRunContext(runId);
        await assertActivity("done", false);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { status: "running", endedAt: Date.now() },
        );
        // A yielded task may retain an active goal without owning a live turn.
        await assertActivity("running", false);
      } finally {
        releaseCapacityWait?.();
        chat?.cleanup();
        clearAgentRunContext(runId);
      }
    });
  },
);
