import { describe, expect, it } from "vitest";
import {
  formatDurableInspectionStoreError,
  projectDurableDeliveryAttempt,
  projectDurableEvent,
  projectDurableHealthSnapshot,
  projectDurableLink,
  projectDurableObligation,
  projectDurableRef,
  projectDurableSignal,
  projectDurableStep,
  projectDurableStoreStats,
  projectDurableTimer,
  projectDurableUncertainty,
} from "./inspection-projection.js";

const PRIVATE_MARKER = "DO_NOT_EXPOSE_FUTURE_FIELD";

function withFuturePrivateField<const T extends object>(value: T): T {
  return { ...value, futurePrivateField: PRIVATE_MARKER } as T;
}

describe("durable inspection projections", () => {
  it("does not expose private storage diagnostics in public errors", () => {
    const privatePath = "/private/state/openclaw.sqlite";
    const privateEndpoint = "https://secret.example.invalid/query?token=private";
    const projected = formatDurableInspectionStoreError(
      new Error(`SQLITE_CANTOPEN ${privatePath}; upstream=${privateEndpoint}`),
    );

    expect(projected).toBe("Durable runtime store is unavailable.");
    expect(projected).not.toContain(privatePath);
    expect(projected).not.toContain(privateEndpoint);
  });

  it("uses explicit allowlists when internal records gain fields", () => {
    const projected = [
      projectDurableStep(
        withFuturePrivateField({
          runtimeRunId: "run-1",
          stepId: "step-1",
          stepType: "tool",
          status: "running",
          recoveryState: "running",
          attempt: 1,
          metadata: { private: PRIVATE_MARKER },
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
      projectDurableEvent(
        withFuturePrivateField({
          eventId: "event-1",
          runtimeRunId: "run-1",
          eventSeq: 1,
          eventType: "test.private",
          eventTime: 2,
          payload: { private: PRIVATE_MARKER },
          recordedAt: 3,
        }),
      ),
      projectDurableLink(
        withFuturePrivateField({
          parentRuntimeRunId: "run-1",
          parentStepId: "step-1",
          childRuntimeRunId: "run-2",
          linkType: "subagent",
          status: "running",
          metadata: { private: PRIVATE_MARKER },
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
      projectDurableSignal(
        withFuturePrivateField({
          signalId: "signal-1",
          runtimeRunId: "run-1",
          signalType: "human_input",
          idempotencyKey: PRIVATE_MARKER,
          metadata: { private: PRIVATE_MARKER },
          receivedAt: 2,
        }),
      ),
      projectDurableTimer(
        withFuturePrivateField({
          timerId: "timer-1",
          runtimeRunId: "run-1",
          timerType: "retry",
          dueAt: 3,
          status: "pending",
          metadata: { private: PRIVATE_MARKER },
          createdAt: 2,
        }),
      ),
      projectDurableRef(
        withFuturePrivateField({
          refId: "ref-1",
          runtimeRunId: "run-1",
          refKind: "artifact",
          storageKind: "file",
          storageUri: `/tmp/${PRIVATE_MARKER}`,
          metadata: { private: PRIVATE_MARKER },
          createdAt: 2,
        }),
      ),
      projectDurableObligation(
        withFuturePrivateField({
          obligationId: "obligation-1",
          sourceOwner: "test_owner",
          sourceRef: "source-1",
          kind: "pending_wake",
          subjectRef: PRIVATE_MARKER,
          status: "pending",
          createdAt: 2,
          updatedAt: 3,
          metadata: { private: PRIVATE_MARKER },
        }),
      ),
      projectDurableUncertainty(
        withFuturePrivateField({
          factId: "fact-1",
          sourceOwner: "test_owner",
          sourceRef: "source-1",
          kind: "requires_owner_decision",
          dedupeKey: PRIVATE_MARKER,
          facts: { private: PRIVATE_MARKER },
          status: "open",
          createdAt: 2,
          updatedAt: 3,
          metadata: { private: PRIVATE_MARKER },
        }),
      ),
      projectDurableDeliveryAttempt(
        withFuturePrivateField({
          deliveryAttemptId: "delivery-1",
          sourceOwner: "test_owner",
          sourceRef: "source-1",
          wakeId: "wake-1",
          dedupeKey: PRIVATE_MARKER,
          status: "pending",
          evidence: { private: PRIVATE_MARKER },
          scheduledAt: 2,
          createdAt: 2,
          updatedAt: 3,
          metadata: { private: PRIVATE_MARKER },
        }),
      ),
      projectDurableStoreStats(
        withFuturePrivateField({
          path: `/tmp/${PRIVATE_MARKER}`,
          runs: 1,
          events: 2,
          steps: 3,
          openRuns: 1,
          pendingWakes: 1,
          unresolvedUncertaintyFacts: 1,
        }),
      ),
      projectDurableHealthSnapshot(
        withFuturePrivateField({
          status: "degraded",
          lastFailure: withFuturePrivateField({
            component: "recovery",
            operation: "inspect",
            message: `failed at /tmp/${PRIVATE_MARKER}`,
            failedAt: 2,
            failureCount: 1,
          }),
        }),
      ),
    ];

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("futurePrivateField");
    expect(serialized).not.toContain(PRIVATE_MARKER);
  });
});
