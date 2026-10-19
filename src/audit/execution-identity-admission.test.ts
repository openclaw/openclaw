import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
  parseExecutionIdentityAdmissionWork,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionWork,
} from "./execution-identity-admission.js";

const ADMISSION_MAX_BYTES = 16 * 1024;
const ADMISSION_MAX_ITEMS = 16;

function defineObjectPrototypeProperty(key: string, descriptor: PropertyDescriptor): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution at the admission boundary.
  Object.defineProperty(Object.prototype, key, descriptor);
}

function restoreObjectPrototypeProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    defineObjectPrototypeProperty(key, descriptor);
  } else {
    delete (Object.prototype as Record<string, unknown>)[key];
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

function captureEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: {
    contextId?: string;
    executionId?: string;
    now?: number;
    runtimeInstanceId?: string;
  } = {},
) {
  let captured: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((work) => {
    if (work.kind === "capture") {
      captured = work.envelope;
    }
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      ...options,
      enabled: true,
    });
    if (!result || !captured) {
      throw new Error("expected admission envelope");
    }
    return captured;
  } finally {
    clear();
  }
}

describe("execution identity admission envelope", () => {
  it("captures a deterministic, deeply frozen, redacted envelope with fixed identity", () => {
    const envelope = captureEnvelope(
      facts({
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "é", state: "present" },
          { rawGrantRef: "z", state: "present" },
          { rawGrantRef: "é", state: "present" },
        ],
        assurance: [
          {
            kind: "runtime-binding",
            rawEvidenceRef: "z",
            strength: "boundary-verified",
          },
          {
            kind: "local-process",
            rawEvidenceRef: "a",
            strength: "boundary-verified",
          },
        ],
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
    expect(envelope.invoker?.state).toBe("present");
    if (envelope.invoker?.state !== "present") {
      throw new Error("expected present invoker");
    }
    expect(envelope.invoker.displayLabel).not.toContain("sk-1234567890abcdef");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.ingress)).toBe(true);
    expect(Object.isFrozen(envelope.assurance)).toBe(true);
    expect(
      parseExecutionIdentityAdmissionWork({ kind: "capture", envelope: structuredClone(envelope) }),
    ).toEqual({ kind: "capture", envelope });
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(
      ADMISSION_MAX_BYTES,
    );
  });

  it.each([["outer run id", "runId", "inherited-run", () => omitOwn(facts(), "runId")]] as const)(
    "rejects inherited required $0 before allocation and enqueue",
    (_name, key, inheritedValue, admissionFacts) => {
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let inheritedReads = 0;
      let allocationReads = 0;
      const sink = vi.fn(() => true);
      const clear = configureExecutionIdentityAdmissionSink(sink);
      try {
        defineObjectPrototypeProperty(key, {
          configurable: true,
          enumerable: false,
          get: () => {
            inheritedReads += 1;
            return inheritedValue;
          },
        });
        const options = { enabled: true, runtimeInstanceId: "runtime-owned" };
        Object.defineProperty(options, "contextId", {
          enumerable: true,
          get: () => {
            allocationReads += 1;
            return "must-not-allocate";
          },
        });
        expect(
          enqueueExecutionIdentityContextAtAdmission(admissionFacts() as never, options),
        ).toBeUndefined();
      } finally {
        clear();
        restoreObjectPrototypeProperty(key, prior);
      }
      expect(inheritedReads).toBe(0);
      expect(allocationReads).toBe(0);
      expect(sink).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed, ambiguous, oversized, and noncanonical invoker variants", () => {
    const present = captureEnvelope(
      facts({
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
        },
      }),
      { contextId: "context-present", executionId: "execution-present", now: 1 },
    );
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
      expect(() =>
        parseExecutionIdentityAdmissionWork({ kind: "capture", envelope: { ...present, invoker } }),
      ).toThrow("execution identity admission envelope violates its bounded contract");
    }
    expect(() =>
      parseExecutionIdentityAdmissionWork({
        kind: "capture",
        envelope: {
          ...present,
          invoker: {
            kind: "local-account",
            state: "present",
            rawPrincipalRef: "raw-principal",
          },
        },
      }),
    ).toThrow("execution identity admission envelope is not canonical");
  });

  it("rejects non-plain or lossy clone data without invoking accessors", () => {
    const envelope = captureEnvelope(facts({ invoker: { state: "unknown" } }), {
      contextId: "context-unknown",
      executionId: "execution-unknown",
      now: 1,
    });
    let accessorReads = 0;
    const accessorEnvelope = { ...envelope };
    Object.defineProperty(accessorEnvelope, "invoker", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { state: "unknown" };
      },
    });
    const symbolEnvelope = { ...envelope, [Symbol("private")]: "raw-symbol-secret" };
    const customPrototypeEnvelope = Object.assign(Object.create({ inherited: true }), envelope);
    const undefinedEnvelope = {
      ...envelope,
      invoker: { state: "unknown", displayLabel: undefined },
    };
    const proxyEnvelope = new Proxy({ ...envelope }, {});
    const customPrototypeFacts = Object.assign(Object.create({ inherited: true }), facts());
    const accessorFacts = facts();
    Object.defineProperty(accessorFacts, "invoker", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { state: "unknown" };
      },
    });

    for (const invalid of [
      accessorEnvelope,
      symbolEnvelope,
      customPrototypeEnvelope,
      undefinedEnvelope,
      proxyEnvelope,
    ]) {
      expect(() =>
        parseExecutionIdentityAdmissionWork({ kind: "capture", envelope: invalid }),
      ).toThrow("execution identity admission data must be clone-safe plain data");
    }
    expect(() => captureEnvelope(customPrototypeFacts)).toThrow("expected admission envelope");
    expect(() => captureEnvelope(accessorFacts)).toThrow("expected admission envelope");
    expect(accessorReads).toBe(0);
  });

  it("revalidates envelopes and worker messages from owned data only", () => {
    const envelope = captureEnvelope(facts(), {
      contextId: "context-revalidation",
      executionId: "execution-revalidation",
      now: 1,
      runtimeInstanceId: "runtime-owned",
    });
    const priorInvoker = Object.getOwnPropertyDescriptor(Object.prototype, "invoker");
    const priorIngress = Object.getOwnPropertyDescriptor(Object.prototype, "ingress");
    const priorKind = Object.getOwnPropertyDescriptor(Object.prototype, "kind");
    let inheritedReads = 0;
    let parsed: ExecutionIdentityAdmissionWork;
    try {
      defineObjectPrototypeProperty("invoker", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return { state: "unknown" };
        },
      });
      parsed = parseExecutionIdentityAdmissionWork({ kind: "capture", envelope });

      defineObjectPrototypeProperty("ingress", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return envelope.ingress;
        },
      });
      expect(() =>
        parseExecutionIdentityAdmissionWork({
          kind: "capture",
          envelope: omitOwn(envelope, "ingress"),
        }),
      ).toThrow("execution identity admission envelope violates its bounded contract");

      defineObjectPrototypeProperty("kind", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedReads += 1;
          return "capture";
        },
      });
      expect(() => parseExecutionIdentityAdmissionWork({ envelope } as never)).toThrow(
        "execution identity admission work violates its bounded contract",
      );
    } finally {
      for (const [key, descriptor] of [
        ["invoker", priorInvoker],
        ["ingress", priorIngress],
        ["kind", priorKind],
      ] as const) {
        restoreObjectPrototypeProperty(key, descriptor);
      }
    }
    expect(inheritedReads).toBe(0);
    if (parsed.kind !== "capture") {
      throw new Error("expected captured admission work");
    }
    expect(Object.hasOwn(parsed.envelope, "invoker")).toBe(false);
  });

  it("rejects invalid owned facts, excess items, and oversized encoded envelopes", () => {
    expect(() =>
      captureEnvelope(facts({ runId: "" }), {
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          applicableGrants: Array.from({ length: ADMISSION_MAX_ITEMS + 1 }, (_, index) => ({
            rawGrantRef: `grant-${String(index)}`,
            state: "present" as const,
          })),
        }),
        { runtimeInstanceId: "runtime-1" },
      ),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            rawSourceRef: "a".repeat(4_096),
          },
          invoker: {
            state: "present",
            kind: "local-account",
            rawPrincipalRef: "b".repeat(4_096),
          },
          applicableGrants: [
            { rawGrantRef: "c".repeat(4_096), state: "present" },
            { rawGrantRef: "d".repeat(4_096), state: "present" },
          ],
        }),
        { runtimeInstanceId: "e".repeat(4_096) },
      ),
    ).toThrow("expected admission envelope");
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
