import { describe, expect, it } from "vitest";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
} from "./session-pending-input-operations.types.js";

const scope = {
  sessionKey: "agent:main:dashboard:incognito-pending-test",
  sessionId: "session-1",
  idempotencyKey: "input-key",
};
const owner = {
  ...scope,
  runId: "run-1",
  requestHash: "hash-1",
  lifecycleGeneration: "lifecycle-1",
};
const message = {
  role: "user",
  content: "original",
  timestamp: 1,
  idempotencyKey: scope.idempotencyKey,
};

function fixture() {
  const state: SessionActorMemoryState = {
    hot: {
      target: {
        database: { kind: "memory", handle: "memory-1", incarnation: "incarnation-1" },
        sessionKey: scope.sessionKey,
      },
      version: { epoch: "epoch-1", sequence: 0 },
      writeToken: "0",
      dependencySessionIds: [scope.sessionId],
      entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        watermark: { generation: null, maxSeq: null },
        version: { generation: null, rawSeq: null, updatedAt: null },
        anchorsState: "resident",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "resident", entries: [] },
      },
    },
    events: [],
    pendingInputs: new Map(),
    completions: new Map(),
    goalReceipts: new Map(),
    historicalWindows: new Map(),
  };
  const grants: Array<{ stage: string; grant: PendingInputCustodyGrant }> = [];
  const pending = createSessionActorMemoryPending(state, {
    agentId: "main",
    path: ":memory:pending-test",
    admit(stage, grant) {
      grants.push({ stage, grant: structuredClone(grant) });
    },
  });
  const stageInput = (
    overrides: Partial<Extract<PendingInputMutation, { kind: "stage" }>> = {},
  ) => {
    const expected = pending.read({ ...scope, ...overrides, kind: "stage", trackCompletion: true });
    if (expected.kind !== "stage") {
      throw new Error("Expected stage snapshot");
    }
    return {
      ...owner,
      kind: "stage" as const,
      expected,
      trackCompletion: true,
      inputId: "input-1",
      messageJson: JSON.stringify(message),
      ...overrides,
    };
  };
  return { state, pending, grants, stageInput };
}

describe("memory actor pending input custody", () => {
  it("reads its writes and adopts the canonical input when a retry proposes new bytes", () => {
    const { state, pending, stageInput } = fixture();
    const before = stageInput();
    const first = pending.mutate(before);
    expect(pending.read({ ...scope, kind: "source", pendingOnly: true })).toMatchObject({
      current: true,
      pending: { input_id: "input-1", message_json: JSON.stringify(message) },
    });
    expect(() => pending.mutate(before)).toThrow("Pending input changed before staging committed");
    const retried = pending.mutate(
      stageInput({
        inputId: "retry-id",
        messageJson: JSON.stringify({ ...message, content: "retry" }),
      }),
    );
    expect(retried.stagedInput).toEqual(first.stagedInput);
    expect(state.hot.pendingInputs).toHaveLength(1);
    expect(state.hot.pendingInputs[0]).not.toHaveProperty("message_json");
    if (!retried.stagedInput) {
      throw new Error("Expected staged input");
    }
    retried.stagedInput.message_json = "caller mutation";
    expect(pending.read({ ...scope, kind: "source", pendingOnly: true })).toMatchObject({
      pending: { message_json: JSON.stringify(message) },
    });
  });

  it("keeps recoverable outcomes replaceable and makes final completion sticky", () => {
    const { state, pending, stageInput } = fixture();
    pending.mutate(stageInput());
    pending.mutate({
      ...owner,
      kind: "complete",
      outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
    });
    expect(state.hot.pendingInputs).toHaveLength(1);
    const completed = { reason: "completed", status: "ok" } as const;
    pending.mutate({ ...owner, kind: "complete", outcome: completed });
    expect(state.hot.pendingInputs).toEqual([]);
    expect(state.hot.completionKeys).toEqual([scope.idempotencyKey]);
    expect(
      pending.mutate({ ...owner, kind: "complete", outcome: { reason: "failed", status: "error" } })
        .outcome,
    ).toEqual(completed);
    expect(pending.read({ ...scope, kind: "stage", trackCompletion: true })).toMatchObject({
      previous: { outcome: completed, succeeded: 1 },
    });
    expect(() =>
      pending.mutate({ ...owner, runId: "other-run", kind: "complete", outcome: completed }),
    ).toThrow("Input completion conflicts with the accepted input");
  });

  it("settles only the accepted owner and supplies current authority to admission", () => {
    const { state, pending, grants, stageInput } = fixture();
    state.hot.members = [{ identityId: "person-1", addedAt: 1, addedBy: "person-1" }];
    if (!state.hot.entry) {
      throw new Error("Expected session");
    }
    state.hot.entry.sessionDiffBaseline = {
      version: 1,
      sessionId: scope.sessionId,
      root: "/synthetic",
      files: [],
    };
    pending.mutate(stageInput({ authorityAgentId: "main" }));
    expect(grants.map(({ stage }) => stage)).toEqual(["transaction", "commit"]);
    expect(grants[0]?.grant.authority).toMatchObject({
      agentId: "main",
      sessionKey: scope.sessionKey,
      members: [{ identityId: "person-1" }],
      readSource: { databaseIdentity: "incarnation-1" },
    });
    expect(grants[0]?.grant.authority?.entry).not.toHaveProperty("sessionDiffBaseline");
    expect(() =>
      pending.mutate({
        ...owner,
        kind: "finish",
        inputId: "input-1",
        requestHash: "other-hash",
        disposition: "cancelled",
      }),
    ).toThrow("Pending input settlement lost its accepted owner");
    expect(
      pending.mutate({ ...owner, kind: "finish", inputId: "input-1", disposition: "cancelled" })
        .withdrawnInputId,
    ).toBe("input-1");
    expect(pending.read({ ...scope, kind: "source", pendingOnly: true })).toMatchObject({
      pending: { state: "cancelled" },
    });
    expect(
      pending.mutate({ ...owner, kind: "finish", inputId: "input-1", disposition: "cancelled" })
        .withdrawnInputId,
    ).toBeUndefined();
  });

  it("finds committed input when pending custody is absent and excludes other sessions", () => {
    const { state, pending } = fixture();
    const event = { type: "message", id: "event-1", message };
    state.events.push({ rawSeq: 1, event, eventJson: JSON.stringify(event) });
    state.hot.transcript.idempotency.push({
      key: scope.idempotencyKey,
      eventId: "event-1",
      rawSeq: 1,
    });
    expect(pending.read({ ...scope, kind: "source", pendingOnly: false })).toEqual({
      kind: "source",
      current: true,
      committed: message,
    });
    expect(pending.read({ ...scope, kind: "source", pendingOnly: true })).toEqual({
      kind: "source",
      current: true,
    });
    expect(pending.read({ ...scope, kind: "stage", trackCompletion: true })).toMatchObject({
      committed: { messageId: "event-1", message },
    });
    expect(
      pending.read({ ...scope, sessionId: "old-session", kind: "source", pendingOnly: false }),
    ).toEqual({ kind: "source", current: false });
  });

  it("pages unconsumed inputs and reconciles receipts without exposing payloads", () => {
    const { state, pending, stageInput } = fixture();
    for (const index of [1, 2, 3]) {
      pending.mutate(
        stageInput({
          idempotencyKey: `key-${index}`,
          inputId: `input-${index}`,
          runId: `run-${index}`,
        }),
      );
    }
    const consumed = state.pendingInputs.get("key-2")!;
    state.pendingInputs.set("key-2", { ...consumed, consumed_event_id: "event-2" });
    const page = pending.history({ ...scope, limit: 1 });
    expect(page.rows.map((row) => row.input_id)).toEqual(["input-3"]);
    expect(page.total).toBe(2);
    expect(
      pending
        .history({ ...scope, limit: 1, before: page.nextBefore })
        .rows.map((row) => row.input_id),
    ).toEqual(["input-1"]);
    expect(pending.history({ ...scope, id: "input-2" }).rows).toEqual([]);
    expect(pending.receipts({ ...scope, runIds: ["run-1", "run-2"] })).toEqual([
      { runId: "run-1", state: "pending" },
      { runId: "run-2", state: "consumed", consumedByEventId: "event-2" },
    ]);
    pending.mutate(
      stageInput({ idempotencyKey: "duplicate-run", inputId: "input-4", runId: "run-1" }),
    );
    expect(() => pending.receipts({ ...scope, runIds: ["run-1"] })).toThrow(
      "ambiguous source run IDs",
    );
  });

  it("interrupts only unconsumed inputs without live custody", () => {
    const { pending, stageInput } = fixture();
    for (const index of [1, 2]) {
      pending.mutate(
        stageInput({
          idempotencyKey: `key-${index}`,
          inputId: `input-${index}`,
          runId: `run-${index}`,
        }),
      );
    }
    const checked: string[] = [];
    const receipt = pending.interruptHistory(
      { ...scope, ids: ["input-1", "input-2"] },
      {
        isProtected(candidate, currentSessionId) {
          checked.push(candidate.input_id);
          return currentSessionId === scope.sessionId && candidate.input_id === "input-1";
        },
        admit() {},
      },
    );
    expect(checked).toEqual(["input-1", "input-2"]);
    expect(receipt).toEqual({ kind: "pending-input-history-interrupted", ids: ["input-2"] });
    expect(pending.history(scope).rows.map(({ input_id, state }) => ({ input_id, state }))).toEqual(
      [
        { input_id: "input-2", state: "interrupted" },
        { input_id: "input-1", state: "queued" },
      ],
    );
  });
});
