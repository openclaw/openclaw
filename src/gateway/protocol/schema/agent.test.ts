import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../../../agents/internal-events.js";
import { AgentParamsSchema } from "./agent.js";

function makeAgentParamsWithInternalEvent(event: AgentInternalEvent) {
  return {
    message: "A music generation task finished. Process the completion update now.",
    sessionKey: "agent:main:discord:channel:1456744319972282449",
    internalEvents: [event],
    idempotencyKey: "music_generate:task-123:ok",
  };
}

const musicCompletionEvent: AgentInternalEvent = {
  type: "task_completion",
  source: "music_generation",
  childSessionKey: "music_generate:task-123",
  childSessionId: "task-123",
  announceType: "music generation task",
  taskLabel: "OpenClaw release anthem",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 track.",
  attachments: [
    {
      type: "audio",
      path: "/tmp/openclaw/generated-release-anthem.mp3",
      mimeType: "audio/mpeg",
      name: "generated-release-anthem.mp3",
    },
  ],
  mediaUrls: ["/tmp/openclaw/generated-release-anthem.mp3"],
  replyInstruction: "Deliver the generated music.",
};

describe("AgentParamsSchema", () => {
  it("accepts generated music attachments on internal completion events", () => {
    const params = makeAgentParamsWithInternalEvent(musicCompletionEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("keeps task completion internal events strict", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      unexpected: true,
    } as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("rejects malformed generated attachment entries on internal events", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      attachments: [null],
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("accepts strict task completion status-card metadata with verifier fields", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      statusCard: {
        kind: "subagent_completion_status",
        schemaVersion: 1,
        normalizedState: "UNVERIFIED",
        classificationLabels: ["UNVERIFIED", "EVIDENCE_UNVERIFIED", "NOT_ACCEPTANCE_EVIDENCE"],
        labels: ["UNVERIFIED", "EVIDENCE_UNVERIFIED", "NOT_ACCEPTANCE_EVIDENCE"],
        presentation: {
          mode: "status_card",
          ordinaryChatBubble: "suppressed",
          collapsedByDefault: true,
          severity: "warning",
          labels: ["UNVERIFIED", "EVIDENCE_UNVERIFIED", "NOT_ACCEPTANCE_EVIDENCE"],
          copyableDebugRefs: {
            artifactId: "q_abc123",
            payloadHash: "abc123",
            byteCount: 42,
          },
        },
        debugRefs: {
          artifactId: "q_abc123",
          payloadHash: "abc123",
          byteCount: 42,
        },
        schemaValid: true,
        notAcceptanceEvidence: true,
        verifierDecision: "EVIDENCE_UNVERIFIED",
        evidenceParentObserved: false,
        evidenceObservedBy: "child",
        evidenceReasons: ["PARENT_RUNTIME_EVIDENCE_CHILD_SELF_ATTESTED"],
        payloadHash: "abc123",
        byteCount: 42,
        deliveryState: "quarantined",
        action: "validate_artifact_or_retry",
        transportOutcome: "completed",
        contractVerdict: "MISSING_VERDICT_SCHEMA",
        acceptanceEligible: false,
        reasons: ["VERDICT_SCHEMA_MISSING_RAW_BODY_SUPPRESSED"],
        quarantine: {
          sha256: "abc123",
          payloadSha256: "abc123",
          payloadHash: "abc123",
          sizeBytes: 42,
          byteCount: 42,
          artifactId: "q_abc123",
          storageStatus: "stored",
          payloadStored: true,
          source: "assistant_output",
        },
        rawOpen: {
          available: true,
          requiredAction: "open_raw_quarantine_artifact",
          localOperatorActionRequired: true,
          warning: "Raw artifact open requires explicit local operator action.",
          artifactId: "q_abc123",
          payloadHash: "abc123",
          byteCount: 42,
          confirmation: {
            required: true,
            artifactId: "q_abc123",
            payloadHash: "abc123",
          },
          authorization: {
            required: true,
            scope: "local_operator",
            status: "not_requested",
          },
          audit: {
            event: "subagent.raw_artifact.open_requested",
            mode: "metadata_only",
          },
          viewer: {
            isolation: "outside_ordinary_chat_model_context_compaction",
            defaultPreview: false,
            snippets: false,
            renderedPayload: false,
            rawDerivedFilename: false,
          },
          redactionScan: {
            scanned: true,
            redacted: false,
            flags: [],
            rawSnippetStored: false,
          },
        },
        evidenceVerifier: {
          decision: "EVIDENCE_UNVERIFIED",
          acceptanceEligible: false,
          parentObserved: false,
          observedBy: "child",
          reasons: ["PARENT_RUNTIME_EVIDENCE_CHILD_SELF_ATTESTED"],
        },
        rawBodySuppressed: true,
        userVisibleSuppressed: true,
        userVisibleSuppressedReason: "raw_output_quarantined",
        dedupe: {
          key: "contract=current|childRun=run-1|childSession=session-1|task=current|result=abc",
          resultHash: "abc",
          seenCount: 1,
          duplicateCount: 0,
          duplicate: false,
          parentEventSuppressed: false,
          activeTaskContractId: "current",
          childRunId: "run-1",
          childSessionId: "session-1",
          taskId: "current",
        },
      },
    });

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("rejects nested or raw status-card data", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      statusCard: {
        kind: "subagent_completion_status",
        deliveryState: "quarantined",
        action: "validate_artifact_or_retry",
        transportOutcome: "completed",
        contractVerdict: "MISSING_VERDICT_SCHEMA",
        acceptanceEligible: false,
        reasons: ["VERDICT_SCHEMA_MISSING_RAW_BODY_SUPPRESSED"],
        rawBodySuppressed: true,
        delivery: { disposition: "quarantine_validate_only" },
        bodyPreview: "raw child output",
      },
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });
});
