import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptDurableRuntimeIntake } from "./intake.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-intake-"));
  const store = openDurableRuntimeSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable runtime intake", () => {
  it("creates idempotent frontdoor runtime runs with stable input refs and initial steps", () => {
    const { store, cleanup } = tempStore();
    try {
      const first = acceptDurableRuntimeIntake({
        store,
        operationKind: "frontdoor.runtime",
        idempotencyKey: "message-1",
        requestHash: "hash-1",
        sourceType: "gateway",
        sourceRef: "channel:main",
        messageId: "message-1",
        input: {
          mediaType: "application/json",
          hash: "hash-1",
          metadata: { channel: "main" },
        },
        initialStep: {
          stepType: "agent",
          maxAttempts: 2,
          metadata: { routeId: "route-parent" },
        },
        metadata: {
          routeId: "route-parent",
        },
        now: 100,
      });
      const duplicate = acceptDurableRuntimeIntake({
        store,
        operationKind: "frontdoor.runtime",
        idempotencyKey: "message-1",
        requestHash: "hash-1",
        sourceType: "gateway",
        sourceRef: "channel:main",
        messageId: "message-1",
        input: {
          mediaType: "application/json",
          hash: "hash-1",
        },
        initialStep: {
          stepType: "agent",
        },
        now: 200,
      });

      expect(duplicate.run.runtimeRunId).toBe(first.run.runtimeRunId);
      expect(duplicate.inputRef?.refId).toBe(first.inputRef?.refId);
      expect(duplicate.initialStep?.stepId).toBe(first.initialStep?.stepId);
      expect(store.listRuns()).toHaveLength(1);
      expect(store.listRefs(first.run.runtimeRunId)).toHaveLength(1);
      expect(store.listSteps(first.run.runtimeRunId)).toHaveLength(1);
      expect(first.run).toMatchObject({
        operationKind: "frontdoor.runtime",
        status: "received",
        recoveryState: "runnable",
        sourceType: "gateway",
        sourceRef: "channel:main",
        messageId: "message-1",
        inputRef: first.inputRef?.refId,
      });
      expect(first.initialStep).toMatchObject({
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        inputRef: first.inputRef?.refId,
        idempotencyKey: "message-1",
        maxAttempts: 2,
      });
    } finally {
      cleanup();
    }
  });
});
