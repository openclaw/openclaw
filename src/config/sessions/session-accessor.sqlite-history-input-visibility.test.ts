import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createSessionHistorySubagentProjection } from "../../gateway/session-history-subagent-projection.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "./session-accessor.js";

it.each([false, true])(
  "bounds legacy coordination lookups and reuses scanned inputs (compacted=%s)",
  async (compacted) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionId: "bounded-coordination-history",
        sessionKey: "agent:main:dashboard:bounded-coordination-history",
        storePath: database.path,
      };
      const provenance = {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceRole: "subagent",
      };
      const messages = [
        {
          role: "user",
          content: "Child report with no later human steering",
          idempotencyKey: "quiet-run:user",
          provenance,
        },
        { role: "assistant", content: "Quiet acknowledgement", __openclaw: { runId: "quiet-run" } },
        {
          role: "user",
          content: "Child report followed by steering",
          idempotencyKey: "steered-run:user",
          provenance,
        },
        {
          role: "assistant",
          content: "Initial acknowledgement",
          __openclaw: { runId: "steered-run" },
        },
        {
          role: "user",
          content: "Counted hidden steering input",
          provenance,
          __openclaw: { steerTargetRunId: "steered-run" },
        },
        { role: "assistant", content: "Internal checkpoint", __openclaw: { runId: "steered-run" } },
        {
          role: "user",
          content: "Now answer my question",
          __openclaw: { steerTargetRunId: "steered-run" },
        },
        { role: "assistant", content: "Visible answer", __openclaw: { runId: "steered-run" } },
        ...Array.from({ length: 2_000 }, (_, index) => ({
          role: "user",
          content: `Unrelated later input ${index}`,
          idempotencyKey: `later-run-${index}:user`,
        })),
      ];
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const events: Parameters<typeof replaceTranscriptEvents>[1] = [
        { type: "session", version: 3, id: scope.sessionId },
      ];
      for (const [index, message] of messages.entries()) {
        events.push({
          type: "message",
          id: `message-${index}`,
          parentId:
            index === 0 ? null : compacted && index === 1 ? "compaction" : `message-${index - 1}`,
          message,
        });
        if (compacted && index === 0) {
          events.push({
            type: "compaction",
            id: "compaction",
            parentId: "message-0",
            firstKeptEntryId: "message-0",
            summary: "Retained worker report",
          });
        }
      }
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);

      const nativeJson = new DatabaseSync(":memory:");
      // JSONB preserves nested JSON values across the counting callback's SQL boundary.
      const extractJson = nativeJson.prepare("SELECT jsonb_extract(?, ?) AS value");
      let laterInputInspections = 0;
      let hiddenSteerInspections = 0;
      database.db.function("json_extract", { deterministic: true }, (value, jsonPath) => {
        if (jsonPath === "$.message.role" && typeof value === "string") {
          laterInputInspections += Number(value.includes("Unrelated later input"));
          hiddenSteerInspections += Number(value.includes("Counted hidden steering input"));
        }
        return extractJson.get(value, jsonPath)?.value ?? null;
      });
      try {
        const resolver = createSessionHistorySubagentProjection(scope);
        const boundaryOffset = Number(compacted);
        expect(resolver.isSubagentRunMessage("quiet-run", 2 + boundaryOffset)).toBe(true);
        expect(laterInputInspections).toBe(0);
        expect(hiddenSteerInspections).toBe(0);
        expect(resolver.isSubagentRunMessage("steered-run", 4 + boundaryOffset)).toBe(true);
        expect(hiddenSteerInspections).toBe(0);
        expect(resolver.isSubagentRunMessage("steered-run", 6 + boundaryOffset)).toBe(true);
        const inspectedHiddenSteer = hiddenSteerInspections;
        expect(inspectedHiddenSteer).toBeGreaterThan(0);
        expect(resolver.isSubagentRunMessage("steered-run", 4 + boundaryOffset)).toBe(true);
        expect(hiddenSteerInspections).toBe(inspectedHiddenSteer);
        expect(resolver.isSubagentRunMessage("steered-run", 8 + boundaryOffset)).toBe(false);
        expect(resolver.isSubagentRunMessage("steered-run", 4 + boundaryOffset)).toBe(true);
        expect(hiddenSteerInspections).toBe(inspectedHiddenSteer);
        expect(laterInputInspections).toBe(0);
      } finally {
        nativeJson.close();
      }
    });
  },
);
