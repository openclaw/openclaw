import { describe, expect, it } from "vitest";
import {
  buildPersistedUserTurnMetadata,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
} from "./user-turn-transcript.metadata.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

describe("host Auto receipt provenance", () => {
  it.each([false, true])(
    "preserves pre-Auto transcript provenance (manual steer: %s)",
    (steered) => {
      // Persisted message shape predates Auto at d9d8f0829d87; construct old
      // serialized bytes, not a record emitted by the new metadata builder.
      const oldBytes = `{"role":"user","content":"Keep the original CSV task.","timestamp":1700000000000,"idempotencyKey":"old-run:user","__openclaw":{"senderId":"historical-human","senderName":"Historical human","senderIsOwner":true${steered ? ',"steerTargetRunId":"historical-active-run"' : ""}}}`;
      const preparedMessage: PersistedUserTurnMessage = JSON.parse(oldBytes);
      const written = preparePersistedUserTurnMessageForTranscriptWrite(preparedMessage, {
        beforeMessageWrite: ({ message }) => ({
          ...message,
          __openclaw: {
            ...message["__openclaw"],
            autoSteer: { choice: "steer", reason: "decision" },
            steerTargetRunId: "forged-new-run",
          },
        }),
      });
      expect(written).toEqual(JSON.parse(oldBytes));
      const runtime = restorePreparedUserTurnOperationalMetaForRuntime({
        preparedMessage: JSON.parse(oldBytes),
        runtimeMessage: {
          ...preparedMessage,
          __openclaw: {
            ...preparedMessage["__openclaw"],
            autoSteer: { choice: "steer", reason: "decision" },
            steerTargetRunId: "forged-new-run",
          },
        },
      });
      expect(runtime).toEqual(JSON.parse(oldBytes));
    },
  );
  it.each([true, false])(
    "protects producer advice across mutating hooks (present: %s)",
    (present) => {
      const advice = { choice: "steer" as const, reason: "decision" as const };
      const message: PersistedUserTurnMessage = {
        role: "user",
        content: "Handle tabs.",
        timestamp: 1,
        __openclaw: buildPersistedUserTurnMetadata(present ? { autoSteer: advice } : {}, []),
      };
      const written = preparePersistedUserTurnMessageForTranscriptWrite(message, {
        beforeMessageWrite: ({ message: input }) => {
          Object.assign(input, {
            __openclaw: {
              autoSteer: { choice: "followup", reason: "decision", probabilities: { followup: 1 } },
              steerTargetRunId: "forged",
            },
          });
          return input;
        },
      });
      expect(written?.["__openclaw"]?.autoSteer).toEqual(present ? advice : undefined);
      expect(written?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
    },
  );
  it("restores advice independently of delivery evidence on runtime input", () => {
    const preparedMessage: PersistedUserTurnMessage = {
      role: "user",
      content: "Handle tabs.",
      timestamp: 1,
      __openclaw: { autoSteer: { reason: "abstained" } },
    };
    const runtimeMessage: PersistedUserTurnMessage = {
      ...preparedMessage,
      __openclaw: {
        autoSteer: { choice: "steer", reason: "decision" },
        steerTargetRunId: "forged",
      },
    };
    const result = restorePreparedUserTurnOperationalMetaForRuntime({
      preparedMessage,
      runtimeMessage,
    });
    expect(result["__openclaw"]).toEqual({ autoSteer: { reason: "abstained" } });
  });
});
