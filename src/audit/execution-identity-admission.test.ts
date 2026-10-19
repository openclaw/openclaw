import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
  parseExecutionIdentityAdmissionWork,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionWork,
} from "./execution-identity-admission.js";
import { captureExecutionIdentityAdmissionEnvelope as captureEnvelope } from "./execution-identity.test-support.js";

function defineObjectPrototypeProperty(key: string, descriptor: PropertyDescriptor): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution at the admission boundary.
  Object.defineProperty(Object.prototype, key, descriptor);
}

function withPrototypeGetters(run: (install: (key: string, value: unknown) => void) => void) {
  let reads = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    prior.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    defineObjectPrototypeProperty(key, {
      configurable: true,
      get: () => {
        reads += 1;
        return value;
      },
    });
  };
  try {
    run(install);
  } finally {
    for (const [key, descriptor] of prior) {
      if (descriptor) {
        defineObjectPrototypeProperty(key, descriptor);
      } else {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
  return reads;
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
  it("captures a deterministic, deeply frozen, redacted envelope with fixed identity", () => {
    const evidence = [
      ["runtime-binding", "z"],
      ["local-process", "a"],
    ] as const;
    const representedSubject = {
      state: "present" as const,
      kind: "person" as const,
      rawPrincipalRef: "selected-person",
    };
    const envelope = captureEnvelope(
      facts({
        invoker: {
          ...presentInvoker(),
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        representedSubject,
        applicableGrants: ["é", "z", "é"].map((rawGrantRef) => ({
          rawGrantRef,
          state: "present" as const,
        })),
        assurance: evidence.map(([kind, rawEvidenceRef]) => ({
          kind,
          rawEvidenceRef,
          strength: "boundary-verified" as const,
        })),
      }),
      {
        contextId: "context-1",
        executionId: "execution-1",
        now: 123,
        runtimeInstanceId: "runtime-1",
      },
    );

    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      contextId: "context-1",
      executionId: "execution-1",
      runId: "run-1",
      createdAt: 123,
      runtimeInstanceId: "runtime-1",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    });
    expect(envelope.applicableGrants).toEqual([
      { rawGrantRef: "z", state: "present" },
      { rawGrantRef: "é", state: "present" },
    ]);
    expect(envelope.invoker).toMatchObject({ state: "present", displayLabel: expect.any(String) });
    expect(JSON.stringify(envelope.invoker)).not.toContain("sk-1234567890abcdef");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.ingress)).toBe(true);
    expect(envelope.representedSubject).toEqual(representedSubject);
    expect(Object.isFrozen(envelope.representedSubject)).toBe(true);
    expect(Object.isFrozen(envelope.assurance)).toBe(true);
    expect(parseEnvelope(structuredClone(envelope))).toEqual({ kind: "capture", envelope });
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("rejects inherited required run id before allocation and enqueue", () => {
    let inheritedReads = 0;
    let allocationReads = 0;
    const sink = vi.fn(() => true);
    const clear = configureExecutionIdentityAdmissionSink(sink);
    try {
      const options = { enabled: true, runtimeInstanceId: "runtime-owned" };
      Object.defineProperty(options, "contextId", {
        enumerable: true,
        get: () => {
          allocationReads += 1;
          return "must-not-allocate";
        },
      });
      inheritedReads = withPrototypeGetters((install) => {
        install("runId", "inherited-run");
        expect(
          enqueueExecutionIdentityContextAtAdmission(omitOwn(facts(), "runId") as never, options),
        ).toBeUndefined();
      });
    } finally {
      clear();
    }
    expect(inheritedReads).toBe(0);
    expect(allocationReads).toBe(0);
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
      { state: "unknown", displayLabel: "replacement label" },
      { state: "unknown", extra: true },
      { state: "present", kind: "local-account", rawPrincipalRef: "x".repeat(4_097) },
      [{ state: "unknown" }],
    ];

    for (const invoker of invalidInvokers) {
      expect(() => parseEnvelope({ ...present, invoker })).toThrow(
        "execution identity admission envelope violates its bounded contract",
      );
    }
    expect(() =>
      parseEnvelope({
        ...present,
        invoker: {
          kind: "local-account",
          state: "present",
          rawPrincipalRef: "raw-principal",
        },
      }),
    ).toThrow("execution identity admission envelope is not canonical");
  });

  it("rejects non-plain or lossy clone data without invoking accessors", () => {
    const envelope = captureEnvelope(facts({ invoker: { state: "unknown" } }));
    let accessorReads = 0;
    const accessorEnvelope = { ...envelope };
    const accessor = {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { state: "unknown" };
      },
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
    expect(accessorReads).toBe(0);
  });

  it("revalidates envelopes and worker messages from owned data only", () => {
    const envelope = captureEnvelope(facts());
    expect(
      withPrototypeGetters((install) => {
        install("invoker", { state: "unknown" });
        const parsed = parseEnvelope(envelope);
        if (parsed.kind !== "capture") {
          throw new Error("expected captured admission work");
        }
        expect(Object.hasOwn(parsed.envelope, "invoker")).toBe(false);
        install("ingress", envelope.ingress);
        expect(() => parseEnvelope(omitOwn(envelope, "ingress"))).toThrow(
          "execution identity admission envelope violates its bounded contract",
        );
        install("kind", "capture");
        expect(() => parseExecutionIdentityAdmissionWork({ envelope } as never)).toThrow(
          "execution identity admission work violates its bounded contract",
        );
      }),
    ).toBe(0);
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

  it("reports queue acceptance without claiming persistence and keeps failures nonblocking", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const clearFirst = configureExecutionIdentityAdmissionSink(first);
    const clearSecond = configureExecutionIdentityAdmissionSink(second);
    clearFirst();
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts(), {
        enabled: true,
        contextId: "context-queued",
        executionId: "execution-queued",
        now: 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toEqual({
      candidateContextId: "context-queued",
      candidateExecutionId: "execution-queued",
      accepted: true,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    clearSecond();
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
    expect(() =>
      enqueueExecutionIdentityContextAtAdmission(
        facts({ ingress: { kind: "local-cli", boundary: "x", rawSourceRef: "raw-secret" } }),
        { enabled: true },
      ),
    ).not.toThrow();
    expect(enqueueExecutionIdentityContextAtAdmission(facts(), { enabled: false })).toBeUndefined();
  });

  it("queues only the safe token for a durable retry reference", () => {
    const work = vi.fn<(item: ExecutionIdentityAdmissionWork) => boolean>(() => true);
    const token = createExecutionIdentityAdmissionToken("run-recovery", {
      contextId: "context-recovery",
      executionId: "execution-recovery",
      now: 123,
    });
    const clear = configureExecutionIdentityAdmissionSink(work);
    try {
      enqueueExecutionIdentityContextAtAdmission(
        facts({
          runId: "run-recovery",
          ingress: {
            kind: "api",
            boundary: "agent-command.from-ingress",
            rawSourceRef: "raw-private-reference",
          },
        }),
        { enabled: true, token, retryOnly: true },
      );
    } finally {
      clear();
    }
    expect(work).toHaveBeenCalledWith({ kind: "retry-reference", token });
    expect(JSON.stringify(work.mock.calls)).not.toContain("raw-private-reference");
  });
});

function omitOwn<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
