import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  parseExecutionIdentityAdmissionWork,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionWork,
} from "./execution-identity-admission.js";
import { captureExecutionIdentityAdmissionEnvelope as captureEnvelope } from "./execution-identity.test-support.js";

function defineObjectPrototypeProperty(key: string, descriptor: PropertyDescriptor): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution at the admission boundary.
  Object.defineProperty(Object.prototype, key, descriptor);
}

function withPrototypeGetters(properties: Record<string, unknown>, run: () => void) {
  const prior = Object.getOwnPropertyDescriptors(Object.prototype);
  const read = vi.fn((value: unknown) => value);
  try {
    for (const [key, value] of Object.entries(properties)) {
      defineObjectPrototypeProperty(key, { configurable: true, get: () => read(value) });
    }
    run();
    expect(read).not.toHaveBeenCalled();
  } finally {
    for (const key of Object.keys(properties)) {
      const descriptor = Object.hasOwn(prior, key) ? prior[key] : undefined;
      if (descriptor) {
        defineObjectPrototypeProperty(key, descriptor);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
}

function facts(overrides: Partial<ExecutionIdentityAdmissionFacts> = {}) {
  return {
    runId: "run-1",
    agentId: "main",
    ingress: { kind: "local-cli" as const, boundary: "agent-command.local" },
    runtime: { kind: "embedded" as const },
    ...overrides,
  };
}

function parseEnvelope(envelope: unknown) {
  return parseExecutionIdentityAdmissionWork({ kind: "capture", envelope });
}

function rejectEnvelope(envelope: unknown, reason = "violates its bounded contract") {
  expect(() => parseEnvelope(envelope)).toThrow(`execution identity admission envelope ${reason}`);
}

function presentInvoker(rawPrincipalRef = "raw-principal") {
  return { state: "present" as const, kind: "local-account" as const, rawPrincipalRef };
}

function expectInvalidFacts(
  overrides: Partial<ExecutionIdentityAdmissionFacts>,
  runtimeInstanceId = "runtime-1",
) {
  expect(() => captureEnvelope(facts(overrides), { runtimeInstanceId })).toThrow(
    "expected admission envelope",
  );
}

describe("execution identity admission envelope", () => {
  it("rejects inherited required run id before allocation and enqueue", () => {
    const allocate = vi.fn(() => "must-not-allocate");
    const sink = vi.fn(() => true);
    const clear = configureExecutionIdentityAdmissionSink(sink);
    try {
      const options = { enabled: true, runtimeInstanceId: "runtime-owned" };
      Object.defineProperty(options, "contextId", { get: allocate });
      withPrototypeGetters({ runId: "inherited-run" }, () => {
        expect(
          enqueueExecutionIdentityContextAtAdmission(omitOwn(facts(), "runId") as never, options),
        ).toBeUndefined();
      });
    } finally {
      clear();
    }
    expect(allocate).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects malformed, ambiguous, oversized, and noncanonical invoker variants", () => {
    const present = captureEnvelope(facts({ invoker: presentInvoker() }));
    const invalidInvokers: unknown[] = [
      { kind: "local-account", rawPrincipalRef: "legacy-untagged" },
      { state: "invalid" },
      { state: "present", kind: "local-account" },
      { state: "present", rawPrincipalRef: "missing-kind" },
      { state: "unknown", kind: "local-account" },
      { state: "unknown", rawPrincipalRef: "raw-substitute-secret" },
      { state: "present", kind: "local-account", rawPrincipalRef: "x".repeat(4_097) },
      [{ state: "unknown" }],
    ];

    for (const invoker of invalidInvokers) {
      rejectEnvelope({ ...present, invoker });
    }
    rejectEnvelope(
      {
        ...present,
        invoker: { kind: "local-account", state: "present", rawPrincipalRef: "raw-principal" },
      },
      "is not canonical",
    );
  });

  it("rejects non-plain or lossy clone data without invoking accessors", () => {
    const envelope = captureEnvelope(facts({ invoker: { state: "unknown" } }));
    const read = vi.fn(() => ({ state: "unknown" }));
    const accessorEnvelope = { ...envelope };
    const accessor = {
      enumerable: true,
      get: read,
    };
    Object.defineProperty(accessorEnvelope, "invoker", accessor);
    const accessorFacts = facts();
    Object.defineProperty(accessorFacts, "invoker", accessor);

    for (const invalid of [
      accessorEnvelope,
      { ...envelope, [Symbol("private")]: "raw-symbol-secret" },
      Object.assign(Object.create({ inherited: true }), envelope),
      { ...envelope, invoker: { state: "unknown", displayLabel: undefined } },
      new Proxy({ ...envelope }, {}),
    ]) {
      expect(() => parseEnvelope(invalid)).toThrow(
        "execution identity admission data must be clone-safe plain data",
      );
    }
    expect(() =>
      captureEnvelope(Object.assign(Object.create({ inherited: true }), facts())),
    ).toThrow("expected admission envelope");
    expect(() => captureEnvelope(accessorFacts)).toThrow("expected admission envelope");
    expect(read).not.toHaveBeenCalled();
  });

  it("revalidates envelopes and worker messages from owned data only", () => {
    const envelope = captureEnvelope(facts());
    withPrototypeGetters(
      { invoker: { state: "unknown" }, ingress: envelope.ingress, kind: "capture" },
      () => {
        const parsed = parseEnvelope(envelope);
        if (parsed.kind !== "capture") {
          throw new Error("expected captured admission work");
        }
        expect(Object.hasOwn(parsed.envelope, "invoker")).toBe(false);
        rejectEnvelope(omitOwn(envelope, "ingress"));
        expect(() => parseExecutionIdentityAdmissionWork({ envelope } as never)).toThrow(
          "execution identity admission work violates its bounded contract",
        );
      },
    );
  });

  it("rejects invalid owned facts, excess items, and oversized encoded envelopes", () => {
    expectInvalidFacts({ runId: "" });
    expectInvalidFacts({
      applicableGrants: Array.from({ length: 16 + 1 }, (_, index) => ({
        rawGrantRef: `grant-${String(index)}`,
        state: "present" as const,
      })),
    });
    expectInvalidFacts(
      {
        ingress: { ...facts().ingress, rawSourceRef: "a".repeat(4_096) },
        invoker: presentInvoker("b".repeat(4_096)),
        applicableGrants: [
          { rawGrantRef: "c".repeat(4_096), state: "present" },
          { rawGrantRef: "d".repeat(4_096), state: "present" },
        ],
      },
      "e".repeat(4_096),
    );
  });

  it("keeps the current sink, queues only safe retry tokens, and leaves failures nonblocking", () => {
    const stale = vi.fn(() => true);
    const clearStale = configureExecutionIdentityAdmissionSink(stale);
    const work = vi.fn<(item: ExecutionIdentityAdmissionWork) => boolean>(() => true);
    const token = createExecutionIdentityAdmissionToken("run-recovery");
    const clear = configureExecutionIdentityAdmissionSink(work);
    clearStale();
    const admission = facts({
      runId: "run-recovery",
      ingress: {
        kind: "api",
        boundary: "agent-command.from-ingress",
        rawSourceRef: "raw-private-reference",
      },
    });
    try {
      expect(
        enqueueExecutionIdentityContextAtAdmission(admission, {
          enabled: true,
          token,
          retryOnly: true,
        })?.accepted,
      ).toBe(true);
    } finally {
      clear();
    }
    expect(stale).not.toHaveBeenCalled();
    expect(work.mock.calls).toEqual([[{ kind: "retry-reference", token }]]);
    expect(JSON.stringify(work.mock.calls)).not.toContain("raw-private-reference");
    expect(() =>
      enqueueExecutionIdentityContextAtAdmission(admission, { enabled: true }),
    ).not.toThrow();
    expect(
      enqueueExecutionIdentityContextAtAdmission(admission, { enabled: false }),
    ).toBeUndefined();
  });
});

function omitOwn<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
