import { serialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { createSqliteWorkerOperationAdmission as createAdmission } from "./sqlite-worker-operation-admission.js";
import { captureSqliteWorkerCommitReceipt as captureReceipt } from "./sqlite-worker-operation-settlement.js";
import {
  getWorkerMessageMetrics,
  recordWorkerMessage,
  recordWorkerAuthorityMessage,
  observeWorkerMessage,
  type WorkerMessageKind,
  type WorkerMessageDirection,
} from "./worker-message-metrics.js";

// Vitest runs this contract in a worker; model the Gateway's main endpoint.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

function increment(kind: WorkerMessageKind, direction: WorkerMessageDirection) {
  const before = getWorkerMessageMetrics().find(
    (row) => row.kind === kind && row.direction === direction,
  );
  return (messages: number, payloadBytes: number, unmeasuredMessages = 0) =>
    expect.objectContaining({
      kind,
      direction,
      messages: (before?.messages ?? 0) + messages,
      payloadBytes: (before?.payloadBytes ?? 0) + payloadBytes,
      unmeasuredMessages: (before?.unmeasuredMessages ?? 0) + unmeasuredMessages,
    });
}

describe("worker message metrics", () => {
  it("keeps unsupported sampled facts and private request classes out of byte totals", () => {
    const read = () =>
      getWorkerMessageMetrics().find(
        (row) => row.kind === "authority" && row.direction === "from_worker",
      )?.payloadComponents?.["session.actor.read"];
    const before = read();
    const wire = { facts: () => undefined };
    expect(() => serialize(wire.facts)).toThrow();
    recordWorkerMessage("authority", "from_worker", undefined, "session.actor.read", wire);
    recordWorkerMessage("authority", "from_worker", undefined, "session.actor.private-id", wire);
    const snapshot = getWorkerMessageMetrics().find(
      (row) => row.kind === "authority" && row.direction === "from_worker",
    );
    expect(Object.keys(snapshot?.payloadComponents ?? {})).not.toContain(
      "session.actor.private-id",
    );
    for (const component of ["admission_entry", "admission_other"] as const) {
      expect(snapshot?.payloadComponents?.["session.actor.read"]?.[component]?.bytes).toBe(
        before?.[component]?.bytes ?? 0,
      );
      expect(snapshot?.payloadComponents?.["session.actor.read"]?.[component]?.samples).toBe(
        before?.[component]?.samples ?? 0,
      );
      expect(snapshot?.payloadComponents?.["session.actor.read"]?.[component]?.unmeasured).toBe(
        (before?.[component]?.unmeasured ?? 0) + 1,
      );
    }
    recordWorkerMessage("authority", "from_worker", undefined, "session.actor.read", { facts: {} });
    expect(snapshot?.payloadComponents?.["session.actor.read"]?.admission_other?.samples).toBe(
      before?.admission_other?.samples ?? 0,
    );
  });
  it.each(["sqlite_request", "sqlite_reply", "authority"] as const)(
    "bounds %s byte classes and keeps totals and snapshots intact",
    (kind) => {
      const before = getWorkerMessageMetrics().find(
        (row) => row.kind === kind && row.direction === "to_worker",
      );
      const expected = increment(kind, "to_worker");
      for (const [requestClass, bytes] of [
        ["audit.writer.process", 12],
        ["session.actor.appendToolResult", 34],
        ["private-suffix", 56],
      ] as const) {
        recordWorkerMessage(kind, "to_worker", bytes, requestClass);
      }
      const snapshot = getWorkerMessageMetrics().find(
        (row) => row.kind === kind && row.direction === "to_worker",
      );
      expect(snapshot).toEqual(expected(3, 102));
      const classes = {
        ...before?.payloadBytesByRequestClass,
        "audit.writer.process":
          (before?.payloadBytesByRequestClass?.["audit.writer.process"] ?? 0) + 12,
        "session.actor.appendToolResult":
          (before?.payloadBytesByRequestClass?.["session.actor.appendToolResult"] ?? 0) + 34,
        other: (before?.payloadBytesByRequestClass?.other ?? 0) + 56,
      };
      expect(snapshot?.payloadBytesByRequestClass).toEqual(classes);
      recordWorkerMessage(kind, "to_worker", 1, "private-suffix");
      expect(snapshot?.payloadBytesByRequestClass).toEqual(classes);
    },
  );

  it.each(["other", "lifecycle"] as const)(
    "attributes resource close requests through %s transport",
    (transport) => {
      const expected = increment("resource", "to_worker");
      const request = { closeResource: true, key: "fixture" };
      observeWorkerMessage(
        transport === "lifecycle" ? { type: "post", value: request } : request,
        "to_worker",
        transport,
      );
      expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 0, 1));
    },
  );

  it("counts both serialized payloads in SQLite open requests", () => {
    const expected = increment("sqlite_request", "to_worker");
    observeWorkerMessage(
      { type: "open", actor: 1, input: new Uint8Array(8), preparation: new Uint8Array(1024) },
      "to_worker",
    );
    expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 1032));
  });

  it("measures encoded reply payloads instead of SQLite continuation metadata", () => {
    const expected = increment("sqlite_reply", "from_worker");
    observeWorkerMessage(
      {
        type: "message",
        id: 1,
        value: { id: 2, ok: true, input: "next", value: new Uint8Array(32) },
      },
      "from_worker",
      "lifecycle",
    );
    expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 32));
  });

  it("separates directions and unknown sizes from measured empty payloads", () => {
    const requests = increment("sqlite_request", "to_worker");
    const replies = increment("sqlite_reply", "from_worker");
    recordWorkerMessage("sqlite_request", "to_worker", 120);
    recordWorkerMessage("sqlite_request", "to_worker", 0);
    recordWorkerMessage("sqlite_reply", "from_worker", 240);
    recordWorkerMessage("sqlite_reply", "from_worker");
    const snapshot = getWorkerMessageMetrics();
    const expectedRequests = requests(2, 120);
    const expectedReplies = replies(2, 240, 1);
    expect(snapshot).toEqual(expect.arrayContaining([expectedRequests, expectedReplies]));
    recordWorkerMessage("sqlite_reply", "from_worker", 60);
    expect(snapshot).toEqual(expect.arrayContaining([expectedReplies]));
    expect(getWorkerMessageMetrics()).toContainEqual(replies(3, 300, 1));
  });
});

it.each([
  "appendedEvents",
  "authorityReceipts",
  "reload",
  "modelPromptProjection",
  "entryMetadata",
  "initialEntry",
  "metadataReload",
])("attributes large %s receipts after native delivery", (shape) => {
  using random = vi.spyOn(Math, "random").mockReturnValue(0);
  const rows = Array.from({ length: 1024 }, (_, rawSeq) => ({
    rawSeq,
    event: `${rawSeq}:${"x".repeat(512)}`,
  }));
  const append = {
    kind: shape === "metadataReload" ? "metadata" : "message",
    value: { reload: shape === "reload" || shape === "metadataReload" ? rows : undefined },
    modelPromptProjection: shape === "modelPromptProjection" ? { rows } : undefined,
    initialEntry: shape === "initialEntry" ? { entry: { rows } } : undefined,
  };
  const outcome = {
    kind: "committed",
    value: append,
    receipt: {
      postimage: { entry: undefined },
      entryMetadata:
        shape === "entryMetadata" ? [{ facts: new Map([["synthetic", rows]]) }] : undefined,
      transcript: {
        append,
        appendedEvents: shape === "appendedEvents" ? rows : undefined,
        authorityReceipts: shape === "authorityReceipts" ? rows : undefined,
      },
    },
  };
  const captured = captureReceipt(outcome);
  if (captured.kind !== "inline") {
    throw new Error("Expected inline fixture");
  }
  const read = () =>
    getWorkerMessageMetrics().find(
      (row) => row.kind === "authority" && row.direction === "from_worker",
    )?.payloadComponents?.["session.actor.appendTranscriptEvent"];
  const before = read();
  const admission = createAdmission((_request, grant) => grant());
  admission.requestClass = "session.actor.appendTranscriptEvent";
  try {
    admission.port.postMessage(
      {
        kind: "native-settlement",
        settlement: {
          kind: "completed",
          committed: { version: 1, sequence: 1, facts: captured.facts },
        },
        payloadBytes: captured.payloadBytes,
      },
      [],
    );
    admission.service();
    expect(random).toHaveBeenCalledTimes(1);
    expect(admission.committed?.facts).toEqual(outcome);
    const after = read();
    const delta = (component: keyof NonNullable<typeof after>) =>
      (after?.[component]?.bytes ?? 0) - (before?.[component]?.bytes ?? 0);
    const sum = (samples: typeof after) =>
      Object.entries(samples ?? {})
        .filter(([key]) => key.startsWith("receipt_"))
        .reduce((total, [, sample]) => total + (sample?.bytes ?? 0), 0);
    expect(sum(after) - sum(before)).toBe(captured.payloadBytes);
    const component =
      shape === "entryMetadata"
        ? "receipt_entry"
        : shape === "appendedEvents" || shape === "authorityReceipts"
          ? "receipt_events"
          : "receipt_value";
    expect(delta(component)).toBeGreaterThan(500_000);
  } finally {
    void admission.finish();
  }
});

it("retains known receipt bytes when attribution throws and skips unsampled facts", () => {
  const requestClass = "session.actor.read";
  const read = () =>
    getWorkerMessageMetrics().find(
      (row) => row.kind === "authority" && row.direction === "from_worker",
    )?.payloadComponents?.[requestClass];
  const before = read();
  const wire = {
    kind: "native-commit",
    payloadBytes: 524288,
    committed: { facts: { receipt: { transcript: () => undefined } } },
  };
  recordWorkerAuthorityMessage(wire, requestClass, false);
  expect(read()).toEqual(before);
  expect(() => recordWorkerAuthorityMessage(wire, requestClass, true)).not.toThrow();
  const after = read();
  expect((after?.receipt_other?.bytes ?? 0) - (before?.receipt_other?.bytes ?? 0)).toBe(
    wire.payloadBytes,
  );
  expect((after?.receipt_other?.unmeasured ?? 0) - (before?.receipt_other?.unmeasured ?? 0)).toBe(
    1,
  );
});

it.each([false, true])("samples complete actor operations with entry reference=%s", (reference) => {
  let draw = 0;
  using random = vi.spyOn(Math, "random").mockImplementation(() => ((draw++ % 128) + 0.5) / 128);
  const requestClass = "session.actor.appendTranscriptEvent";
  const read = () =>
    getWorkerMessageMetrics().find(
      (row) => row.kind === "authority" && row.direction === "from_worker",
    )?.payloadComponents?.[requestClass];
  const before = read();
  const entry = {
    sessionId: "synthetic-private-session",
    skillsSnapshot: { prompt: "x".repeat(130_000) },
  };
  const facts = {
    identity: { physicalIdentity: "synthetic-database" },
    publication: {
      kind: "session-actor-admission",
      snapshot: reference ? { entryReference: 1 } : { entry },
    },
  };
  const outcome = {
    kind: "committed",
    value: { modelPromptProjection: "projection".repeat(100) },
    receipt: {
      postimage: { entry },
      entryMetadata: [
        {
          facts: new Map([
            ["synthetic-private-key", { kind: "postimage", value: { entry, fullEntry: entry } }],
          ]),
        },
      ],
      transcript: {
        appendedEvents: [{ event: "event".repeat(100) }],
        authorityReceipts: [{ bytes: new Uint8Array(128) }],
      },
    },
  };
  const captured = captureReceipt(outcome);
  if (captured.kind !== "inline") {
    throw new Error("Expected inline fixture");
  }
  const serialized = serialize(outcome);
  for (let operation = 0; operation < 128; operation++) {
    const admission = createAdmission((_request, grant) => grant());
    admission.requestClass = requestClass;
    try {
      for (const stage of ["transaction", "commit"]) {
        const decision = new SharedArrayBuffer(4);
        admission.port.postMessage({ stage, facts, decision, ports: [] }, []);
        admission.service();
        expect(Atomics.load(new Int32Array(decision), 0)).toBe(1);
      }
      admission.port.postMessage(
        {
          kind: "native-commit",
          committed: { version: 1, sequence: 1, facts: captured.facts },
          payloadBytes: captured.payloadBytes,
        },
        [],
      );
      admission.port.postMessage(
        {
          kind: "native-settlement",
          settlement: { kind: "completed" },
          payloadBytes: 0,
        },
        [],
      );
      admission.service();
      expect(admission.committed?.facts).toEqual(outcome);
    } finally {
      void admission.finish();
    }
  }
  expect(random).toHaveBeenCalledTimes(128);
  const after = read();
  const delta = (component: keyof NonNullable<typeof after>, field: "bytes" | "samples") =>
    (after?.[component]?.[field] ?? 0) - (before?.[component]?.[field] ?? 0);
  expect(delta("admission_other", "samples")).toBe(2);
  expect(delta("receipt_other", "samples")).toBe(1);
  expect(delta("admission_entry", "bytes") + delta("admission_other", "bytes")).toBe(
    2 * serialize(facts).byteLength,
  );
  if (reference) {
    expect(delta("admission_entry", "bytes")).toBe(0);
  } else {
    expect(delta("admission_entry", "bytes")).toBeGreaterThan(260_000);
  }
  expect(delta("receipt_entry", "bytes")).toBeGreaterThan(130_000);
  expect(delta("receipt_events", "bytes")).toBeGreaterThan(528);
  expect(
    delta("receipt_entry", "bytes") +
      delta("receipt_events", "bytes") +
      delta("receipt_value", "bytes") +
      delta("receipt_other", "bytes"),
  ).toBe(serialized.byteLength);
  expect(JSON.stringify(after)).not.toMatch(/synthetic-private|projection|prompt/);
});
