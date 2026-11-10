import { describe, expect, it } from "vitest";
import {
  attachRuntimeUserTurnTranscriptContext,
  attachRuntimeUserTurnTranscriptRecorder,
  takeRuntimeUserTurnTranscriptContext,
  takeRuntimeUserTurnTranscriptRecorder,
} from "./user-turn-transcript-runtime-context.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

function createRecorder(): UserTurnTranscriptRecorder {
  return {
    message: undefined,
    resolveMessage: async () => undefined,
    getAdmissionReceipt: () => undefined,
    markRuntimePersistencePending: () => {},
    markRuntimePersisted: () => {},
    markBlocked: () => {},
    hasPersisted: () => false,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}

describe("queued transcript carriers", () => {
  it("retains exact private context without changing model-visible message bytes", () => {
    const runtime: PersistedUserTurnMessage = { role: "user", content: "runtime", timestamp: 1 };
    const message: PersistedUserTurnMessage = { role: "user", content: "original", timestamp: 1 };
    const context = { message, recorder: createRecorder() };
    const visible = JSON.stringify(runtime);
    expect(attachRuntimeUserTurnTranscriptContext(runtime, context)).toBe(runtime);
    expect(JSON.stringify(runtime)).toBe(visible);
    expect(takeRuntimeUserTurnTranscriptContext({ ...runtime })).toBeUndefined();
    expect(takeRuntimeUserTurnTranscriptContext(runtime)).toBe(context);
    expect(takeRuntimeUserTurnTranscriptContext(runtime)).toBeUndefined();
    expect(Object.getOwnPropertySymbols(runtime)).toEqual([]);
  });

  it("consumes the exact recorder independently of queued context", () => {
    const runtime: PersistedUserTurnMessage = { role: "user", content: "runtime", timestamp: 1 };
    const recorder = createRecorder();
    const context = { message: runtime, recorder: createRecorder() };
    attachRuntimeUserTurnTranscriptContext(runtime, context);
    expect(attachRuntimeUserTurnTranscriptRecorder(runtime, recorder)).toBe(runtime);
    expect(takeRuntimeUserTurnTranscriptRecorder({ ...runtime })).toBeUndefined();
    expect(takeRuntimeUserTurnTranscriptRecorder(runtime)).toBe(recorder);
    expect(takeRuntimeUserTurnTranscriptRecorder(runtime)).toBeUndefined();
    expect(takeRuntimeUserTurnTranscriptContext(runtime)).toBe(context);
    expect(Object.getOwnPropertySymbols(runtime)).toEqual([]);
  });
});
