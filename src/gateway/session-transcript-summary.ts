import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createConversationSkillLoadCollector,
  type ConversationSkillLoad,
} from "../chat/conversation-skills.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import type { McpAppReconstructionData, McpAppTranscriptLookup } from "./mcp-app-transcript.js";
import type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";
import type { SubagentCoordinationDisplayResolver } from "./session-transcript-read.types.js";

export type SessionTranscriptSummaryQuery =
  | { kind: "usage" }
  | { kind: "skills-used" }
  | { kind: "mcp-app"; lookup: McpAppTranscriptLookup };

export type SessionTranscriptSummaryResult =
  | { kind: "skills-used"; loads: ConversationSkillLoad[] }
  | { kind: "usage"; usage: SessionTranscriptUsageSnapshot | null }
  | { kind: "mcp-app"; data: McpAppReconstructionData | undefined };

type TranscriptVisit = (visit: (message: unknown, seq?: number) => void) => void;

/** Load domain policy before opening the snapshot; only compact facts cross the worker boundary. */
export async function prepareSessionTranscriptSummaryReader(
  query: SessionTranscriptSummaryQuery,
  visibility?: SubagentCoordinationDisplayResolver,
): Promise<(visit: TranscriptVisit) => SessionTranscriptSummaryResult> {
  if (query.kind === "skills-used") {
    return (visit) => {
      const collector = createConversationSkillLoadCollector();
      visit((message, seq) => {
        const nested = asOptionalRecord(asOptionalRecord(message)?.details);
        const runId =
          readSessionTranscriptRunId(message) ??
          (typeof nested?.runId === "string" ? nested.runId : undefined);
        if (runId && visibility?.isSubagentRunMessage(runId, seq)) {
          return;
        }
        collector.add(message);
      });
      visibility?.assertCurrent?.();
      return { kind: "skills-used", loads: collector.finish() };
    };
  }
  if (query.kind === "mcp-app") {
    const { selectMcpAppReconstructionData } = await import("./mcp-app-transcript.js");
    return (visit) => ({
      kind: "mcp-app",
      data: selectMcpAppReconstructionData(visit, query.lookup),
    });
  }
  const { createSessionTranscriptUsageAccumulator } =
    await import("./session-transcript-derived-readers.js");
  return (visit) => {
    const usage = createSessionTranscriptUsageAccumulator();
    visit(usage.add);
    return { kind: "usage", usage: usage.finish() };
  };
}
