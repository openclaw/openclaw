import { afterEach, describe, expect, it } from "vitest";
import {
  CONTINUATION_SIGNAL_KINDS,
  emitContinuationCompactionReleasedSpan,
  emitContinuationDelegateFireSpan,
  emitContinuationDelegateSpan,
  emitContinuationDisabledSpan,
  emitContinuationFanoutSpan,
  emitContinuationQueueDrainSpan,
  emitContinuationWorkSpan,
  getContinuationTracer,
  noopTracer,
  resetContinuationTracer,
  setContinuationTracer,
  type ContinuationDisabledSignalKind,
  type ContinuationSignalKind,
  type ContinuationSpanAttrs,
  type ContinuationSpanName,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "./continuation-tracer.js";

afterEach(() => {
  resetContinuationTracer();
});

describe("continuation-tracer :: noop default contract", () => {
  it("default tracer is the no-op tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("noopTracer.startSpan returns a span with all methods callable as no-ops", () => {
    const span = noopTracer.startSpan("continuation.work");
    // None of these should throw — the no-op surface is the safety net for
    // un-opted callers.
    expect(() => span.setAttributes({ "chain.id": "x" })).not.toThrow();
    expect(() => span.setStatus("OK")).not.toThrow();
    expect(() => span.setStatus("ERROR", "boom")).not.toThrow();
    expect(() => span.recordException(new Error("boom"))).not.toThrow();
    expect(() => span.recordException("plain-string")).not.toThrow();
    expect(() => span.end()).not.toThrow();
    // end() is idempotent.
    expect(() => span.end()).not.toThrow();
  });

  it("noopTracer ignores StartSpanOptions (attrs + traceparent) without throwing", () => {
    const opts: StartSpanOptions = {
      attributes: { "chain.id": "abc", "chain.step.remaining": 5 },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    };
    expect(() => noopTracer.startSpan("continuation.work", opts)).not.toThrow();
  });
});

describe("continuation-tracer :: registry (set/get/reset)", () => {
  it("setContinuationTracer installs a custom tracer; getContinuationTracer returns it", () => {
    const calls: Array<{ name: string; opts?: StartSpanOptions }> = [];
    const recorded: Array<{ method: string; args: unknown[] }> = [];

    const recordingSpan: Span = {
      setAttributes(attrs: SpanAttributes): void {
        recorded.push({ method: "setAttributes", args: [attrs] });
      },
      setStatus(status: SpanStatus, message?: string): void {
        recorded.push({ method: "setStatus", args: [status, message] });
      },
      recordException(err: unknown): void {
        recorded.push({ method: "recordException", args: [err] });
      },
      end(): void {
        recorded.push({ method: "end", args: [] });
      },
    };

    const recordingTracer: Tracer = {
      startSpan(name: string, opts?: StartSpanOptions): Span {
        calls.push({ name, opts });
        return recordingSpan;
      },
    };

    setContinuationTracer(recordingTracer);
    expect(getContinuationTracer()).toBe(recordingTracer);

    const span = getContinuationTracer().startSpan("continuation.work", {
      attributes: { "chain.id": "test-chain" },
    });
    span.setAttributes({ "chain.step.remaining": 4 });
    span.setStatus("OK");
    span.end();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("continuation.work");
    expect(calls[0]?.opts?.attributes?.["chain.id"]).toBe("test-chain");
    expect(recorded.map((r) => r.method)).toEqual(["setAttributes", "setStatus", "end"]);
  });

  it("setContinuationTracer(null) resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    setContinuationTracer(null);
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("setContinuationTracer(undefined) resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    setContinuationTracer(undefined);
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("resetContinuationTracer() resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    resetContinuationTracer();
    expect(getContinuationTracer()).toBe(noopTracer);
  });
});

describe("continuation-tracer :: contract pin", () => {
  // These tests pin the canonical span names and attribute names so a rename
  // fails near the source.

  it("canonical continuation span names are accepted by the surface", () => {
    const recorded: string[] = [];
    setContinuationTracer({
      startSpan: (name) => {
        recorded.push(name);
        return noopTracer.startSpan(name);
      },
    });

    const tracer = getContinuationTracer();
    tracer.startSpan("continuation.work");
    tracer.startSpan("continuation.work.fire");
    tracer.startSpan("continuation.delegate.dispatch");
    tracer.startSpan("continuation.delegate.fire");
    tracer.startSpan("continuation.queue.enqueue");
    tracer.startSpan("continuation.queue.fanout");
    tracer.startSpan("continuation.queue.drain");
    tracer.startSpan("continuation.compaction.released");
    tracer.startSpan("continuation.disabled");
    tracer.startSpan("heartbeat");

    expect(recorded).toEqual([
      "continuation.work",
      "continuation.work.fire",
      "continuation.delegate.dispatch",
      "continuation.delegate.fire",
      "continuation.queue.enqueue",
      "continuation.queue.fanout",
      "continuation.queue.drain",
      "continuation.compaction.released",
      "continuation.disabled",
      "heartbeat",
    ]);
  });

  it("canonical attribute names round-trip through the surface", () => {
    let captured: SpanAttributes | undefined;
    setContinuationTracer({
      startSpan: (_name, opts) => {
        captured = opts?.attributes;
        return noopTracer.startSpan(_name);
      },
    });

    getContinuationTracer().startSpan("continuation.work", {
      attributes: {
        "chain.id": "01J0X0000000000000000000A0",
        "chain.step.remaining": 4,
        "delay.ms": 30000,
        "reason.preview": "context-pressure handoff",
      },
    });

    expect(captured?.["chain.id"]).toBe("01J0X0000000000000000000A0");
    expect(captured?.["chain.step.remaining"]).toBe(4);
    expect(captured?.["delay.ms"]).toBe(30000);
    expect(captured?.["reason.preview"]).toBe("context-pressure handoff");
  });

  // Type-level pin: ContinuationSpanAttrs is the load-bearing canonical
  // attribute-name shape. If the OTEL adapter ever drifts to
  // chain_id / chainId / camelCase / etc., the assignment below fails
  // compile before runtime trace assertions could catch it.
  it("ContinuationSpanAttrs is structurally compatible with SpanAttributes", () => {
    const canonical: ContinuationSpanAttrs = {
      "chain.id": "abc",
      "chain.step.remaining": 3,
      "delay.ms": 1000,
      "reason.preview": "x",
      "delegate.mode": "silent-wake",
      "continuation.disabled": false,
    };
    // Assignment to SpanAttributes is the compile-time pin: every
    // ContinuationSpanAttrs MUST be a valid SpanAttributes for the shim
    // surface to accept it.
    const broad: SpanAttributes = canonical;
    expect(broad["chain.id"]).toBe("abc");
  });

  it("ContinuationSpanName values are all accepted by startSpan", () => {
    // Compile-time pin: each canonical name MUST be assignable to the
    // ContinuationSpanName union.
    const names: ContinuationSpanName[] = [
      "continuation.work",
      "continuation.work.fire",
      "continuation.delegate.dispatch",
      "continuation.delegate.fire",
      "continuation.queue.enqueue",
      "continuation.queue.fanout",
      "continuation.queue.drain",
      "continuation.compaction.released",
      "continuation.disabled",
      "heartbeat",
    ];
    for (const name of names) {
      expect(() => noopTracer.startSpan(name)).not.toThrow();
    }
  });

  it("signal.kind canonical values round-trip through the surface (runtime pin, SSOT-derived)", () => {
    // Derived from CONTINUATION_SIGNAL_KINDS SSOT — no inline re-enumeration.
    let captured: SpanAttributes | undefined;
    setContinuationTracer({
      startSpan: (_name, opts) => {
        captured = opts?.attributes;
        return noopTracer.startSpan(_name);
      },
    });
    for (const kind of CONTINUATION_SIGNAL_KINDS) {
      getContinuationTracer().startSpan("heartbeat", {
        attributes: { "signal.kind": kind },
      });
      expect(captured?.["signal.kind"]).toBe(kind);
    }
  });

  it("signal.kind canonical values are type-compatible with ContinuationSpanAttrs (type-pin, SSOT-derived)", () => {
    // Derived from CONTINUATION_SIGNAL_KINDS SSOT — no inline re-enumeration.
    for (const v of CONTINUATION_SIGNAL_KINDS) {
      const attrs: ContinuationSpanAttrs = { "signal.kind": v };
      const broad: SpanAttributes = attrs;
      expect(broad["signal.kind"]).toBe(v);
    }
  });
});

describe("continuation-tracer :: emitContinuationWorkSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.work span with all expected attrs when chainId is present", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 7,
      delayMs: 30000,
      reason: "more work to do",
    });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("continuation.work");
    expect(span.options?.attributes).toEqual({
      "delay.ms": 30000,
      "chain.step.remaining": 7,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "reason.preview": "more work to do",
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("omits chain.id and reason.preview when not provided", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      delayMs: 5000,
    });
    expect(spans[0].options?.attributes).toEqual({
      "delay.ms": 5000,
      "chain.step.remaining": 0,
    });
  });

  it("truncates reason to 80 chars", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const long = "x".repeat(200);
    emitContinuationWorkSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 100,
      reason: long,
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["reason.preview"]).toBe("x".repeat(80));
  });

  it("rounds delayMs to integer", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({ chainId: undefined, chainStepRemaining: 0, delayMs: 1234.7 });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["delay.ms"]).toBe(1235);
  });

  it("clamps negative chainStepRemaining to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({ chainId: undefined, chainStepRemaining: -3, delayMs: 0 });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["chain.step.remaining"]).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwingTracer: Tracer = {
      startSpan() {
        throw new Error("boom");
      },
    };
    setContinuationTracer(throwingTracer);
    const messages: string[] = [];
    expect(() =>
      emitContinuationWorkSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        log: (m) => messages.push(m),
      }),
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("boom");
  });

  it("is a no-op (no throw) against the default noop tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
    expect(() =>
      emitContinuationWorkSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        reason: "r",
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationDelegateSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.delegate.dispatch span with all expected attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 5,
      delayMs: 60000,
      delivery: "timer",
      delegateMode: "silent-wake",
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("continuation.delegate.dispatch");
    expect(span.options?.attributes).toEqual({
      "delay.ms": 60000,
      "chain.step.remaining": 5,
      "delegate.delivery": "timer",
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "delegate.mode": "silent-wake",
      "reason.preview": "fan out three queries",
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("immediate-delivery shape with no chainId or mode", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      delayMs: 0,
      delivery: "immediate",
    });
    expect(spans[0].options?.attributes).toEqual({
      "delay.ms": 0,
      "chain.step.remaining": 0,
      "delegate.delivery": "immediate",
    });
  });

  it("parents dispatch spans to a supplied traceparent", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 0,
      delivery: "immediate",
      traceparent,
    });

    expect(spans[0].options?.traceparent).toBe(traceparent);
  });

  it("omits traceparent options when no parent carrier is supplied", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 0,
      delivery: "immediate",
    });

    expect(spans[0].options?.traceparent).toBeUndefined();
  });

  it("threads delegate.mode through unchanged", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const mode of ["normal", "silent", "silent-wake", "post-compaction"] as const) {
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        delegateMode: mode,
      });
    }
    expect(
      spans.map((s) => (s.options?.attributes as ContinuationSpanAttrs)["delegate.mode"]),
    ).toEqual(["normal", "silent", "silent-wake", "post-compaction"]);
  });

  it("truncates reason to 80 chars", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 100,
      delivery: "timer",
      reason: "y".repeat(200),
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["reason.preview"]).toBe(
      "y".repeat(80),
    );
  });

  it("rounds delayMs and clamps negative chainStepRemaining", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: undefined,
      chainStepRemaining: -2,
      delayMs: 4567.89,
      delivery: "timer",
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["delay.ms"]).toBe(4568);
    expect(attrs["chain.step.remaining"]).toBe(0);
  });

  it("swallows tracer errors and forwards to log callback", () => {
    const throwingTracer: Tracer = {
      startSpan() {
        throw new Error("kaboom");
      },
    };
    setContinuationTracer(throwingTracer);
    const messages: string[] = [];
    expect(() =>
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        log: (m) => messages.push(m),
      }),
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("kaboom");
    expect(messages[0]).toContain("continuation.delegate.dispatch");
  });

  it("is a no-op against the default noop tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
    expect(() =>
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        delegateMode: "normal",
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationDisabledSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options: StartSpanOptions | undefined;
    statusCalls: { status: SpanStatus; message?: string | undefined }[];
    attrCalls: SpanAttributes[];
    exceptions: unknown[];
    ended: boolean;
  };
  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const rec: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          attrCalls: [],
          exceptions: [],
          ended: false,
        };
        spans.push(rec);
        const span: Span = {
          setAttributes(attrs) {
            rec.attrCalls.push(attrs);
          },
          setStatus(status, message) {
            rec.statusCalls.push({ status, message });
          },
          recordException(err) {
            rec.exceptions.push(err);
          },
          end() {
            rec.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.disabled span with full attrs for delegate cap.chain reject", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent",
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("continuation.disabled");
    expect(span.options?.attributes).toEqual({
      "chain.step.remaining": 0,
      "disabled.reason": "cap.chain",
      "signal.kind": "tool-delegate",
      "continuation.disabled": true,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "delegate.delivery": "timer",
      "delegate.mode": "silent",
      "reason.preview": "fan out three queries",
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("work-signal reject omits delegate.* attrs (work has no transport/intent axis)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: undefined, // first-step reject — chain never started
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "bracket-work",
    });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes;
    expect(attrs).toEqual({
      "chain.step.remaining": 0,
      "disabled.reason": "cap.chain",
      "signal.kind": "bracket-work",
      "continuation.disabled": true,
    });
    expect(attrs).not.toHaveProperty("chain.id");
    expect(attrs).not.toHaveProperty("delegate.delivery");
    expect(attrs).not.toHaveProperty("delegate.mode");
  });

  it("cost-cap reject for bracket-delegate carries delegate axes", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 3,
      disabledReason: "cap.cost",
      signalKind: "bracket-delegate",
      delegateDelivery: "immediate",
      delegateMode: "normal",
    });
    expect(spans[0].options?.attributes).toMatchObject({
      "disabled.reason": "cap.cost",
      "signal.kind": "bracket-delegate",
      "delegate.delivery": "immediate",
      "delegate.mode": "normal",
      "chain.step.remaining": 3,
    });
  });

  it("per-turn cap reject for tool-delegate carries delegate axes and live headroom", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262099",
      chainStepRemaining: 12,
      disabledReason: "cap.delegates_per_turn",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent-wake",
      reason: "poll PR #999 status",
    });
    expect(spans[0].options?.attributes).toMatchObject({
      "disabled.reason": "cap.delegates_per_turn",
      "signal.kind": "tool-delegate",
      "delegate.delivery": "timer",
      "delegate.mode": "silent-wake",
      "chain.step.remaining": 12,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262099",
      "reason.preview": "poll PR #999 status",
      "continuation.disabled": true,
    });
  });

  it("truncates reason to 80 chars", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const longReason = "x".repeat(200);
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
      reason: longReason,
    });
    expect(spans[0].options?.attributes?.["reason.preview"]).toHaveLength(80);
  });

  it("clamps negative chainStepRemaining to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: -7,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
    });
    expect(spans[0].options?.attributes?.["chain.step.remaining"]).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("tracer-disabled");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: 0,
        disabledReason: "cap.chain",
        signalKind: "tool-delegate",
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.disabled span/);
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: 0,
        disabledReason: "cap.chain",
        signalKind: "tool-delegate",
      }),
    ).not.toThrow();
  });

  it("accepts disabledReason='reservation.missing'", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262099",
      chainStepRemaining: 4,
      disabledReason: "reservation.missing",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent-wake",
    });
    expect(spans[0].options?.attributes).toMatchObject({
      "disabled.reason": "reservation.missing",
      "signal.kind": "tool-delegate",
      "delegate.delivery": "timer",
      "delegate.mode": "silent-wake",
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262099",
      "continuation.disabled": true,
    });
  });
});

describe("continuation-tracer :: emitContinuationDelegateFireSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options: StartSpanOptions | undefined;
    statusCalls: { status: SpanStatus; message?: string | undefined }[];
    attrCalls: SpanAttributes[];
    exceptions: unknown[];
    ended: boolean;
  };
  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const rec: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          attrCalls: [],
          exceptions: [],
          ended: false,
        };
        spans.push(rec);
        const span: Span = {
          setAttributes(attrs) {
            rec.attrCalls.push(attrs);
          },
          setStatus(status, message) {
            rec.statusCalls.push({ status, message });
          },
          recordException(err) {
            rec.exceptions.push(err);
          },
          end() {
            rec.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.delegate.fire span with all required attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemainingAtDispatch: 4,
      delegateMode: "silent-wake",
      delayMs: 60_000,
      fireDeferredMs: 60_017,
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("continuation.delegate.fire");
    expect(span.options?.attributes).toEqual({
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "chain.step.remaining": 4,
      "delay.ms": 60_000,
      "fire.deferred_ms": 60_017,
      "delegate.delivery": "timer",
      "delegate.mode": "silent-wake",
      "reason.preview": "fan out three queries",
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("carries fire.deferred_ms with Math.floor (integer ms, drift formula consumer-ready)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 1,
      delegateMode: "normal",
      delayMs: 1_000,
      fireDeferredMs: 1_234.9, // floored to 1234
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["fire.deferred_ms"]).toBe(1234);
  });

  it("clamps negative fireDeferredMs to 0 (defense; should never happen in practice)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 1,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: -3,
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["fire.deferred_ms"]).toBe(0);
  });

  it("truncates reason.preview to 80 chars", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 0,
      delegateMode: "silent",
      delayMs: 100,
      fireDeferredMs: 105,
      reason: "z".repeat(200),
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["reason.preview"]).toBe(
      "z".repeat(80),
    );
  });

  it("clamps negative chainStepRemainingAtDispatch to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: -2,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 1,
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["chain.step.remaining"]).toBe(0);
  });

  it("threads each delegateMode through unchanged", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const mode of ["normal", "silent", "silent-wake"] as const) {
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 1,
        delegateMode: mode,
        delayMs: 0,
        fireDeferredMs: 0,
      });
    }
    expect(
      spans.map((s) => (s.options?.attributes as ContinuationSpanAttrs)["delegate.mode"]),
    ).toEqual(["normal", "silent", "silent-wake"]);
  });

  it("always emits delegate.delivery='timer' as a fixed attr (not arg-driven)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 0,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 0,
    });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["delegate.delivery"]).toBe(
      "timer",
    );
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-fire");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 0,
        delegateMode: "normal",
        delayMs: 0,
        fireDeferredMs: 0,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.delegate\.fire span/);
    expect(logged[0]).toContain("kaboom-fire");
  });

  it("defense-in-depth: undefined chainId no-ops + logs (invariant break must not crash fire-emit)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationDelegateFireSpan({
      // Sig says `chainId: string`, but a future invariant break could
      // let undefined slip through; cast through unknown to simulate.
      chainId: undefined as unknown as string,
      chainStepRemainingAtDispatch: 0,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 0,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/chainId invariant violated/);
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 1,
        delegateMode: "normal",
        delayMs: 0,
        fireDeferredMs: 0,
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationQueueDrainSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.queue.drain span with the canonical attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 3,
      drainedContinuationCount: 1,
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("continuation.queue.drain");
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(3);
    expect(attrs["queue.drained_continuation_count"]).toBe(1);
    expect(spans[0].statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(spans[0].ended).toBe(true);
  });

  it("emits a 0/0 span on empty drain (absence-of-work, not rejection)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 0,
      drainedContinuationCount: 0,
    });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(0);
    expect(attrs["queue.drained_continuation_count"]).toBe(0);
    // No `continuation.disabled` attr on empty drain — drain has no gate.
    expect(attrs["continuation.disabled"]).toBeUndefined();
    expect(attrs["disabled.reason"]).toBeUndefined();
  });

  it("parents drain spans to the supplied traceparent when a drained entry carries one", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 1,
      traceparent,
    });

    expect(spans[0].options?.traceparent).toBe(traceparent);
  });

  it("omits traceparent options for untraced drains", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 1,
    });

    expect(spans[0].options?.traceparent).toBeUndefined();
  });

  it("does NOT carry chain.id or chain.step.remaining (multi-chain seam)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 5,
      drainedContinuationCount: 2,
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["chain.id"]).toBeUndefined();
    expect(attrs["chain.step.remaining"]).toBeUndefined();
    expect(attrs["delay.ms"]).toBeUndefined();
    expect(attrs["fire.deferred_ms"]).toBeUndefined();
    expect(attrs["delegate.mode"]).toBeUndefined();
    expect(attrs["signal.kind"]).toBeUndefined();
  });

  it("clamps negative counts to 0 (defense-in-depth on integer hygiene)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: -1,
      drainedContinuationCount: -3,
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(0);
    expect(attrs["queue.drained_continuation_count"]).toBe(0);
  });

  it("caps drainedContinuationCount by drainedCount (\u2264 invariant defense-in-depth)", () => {
    // The wire site already guarantees continuation <= total (filter over same
    // array), but a less-disciplined caller could violate. Helper enforces the
    // invariant.
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 5,
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(2);
    expect(attrs["queue.drained_continuation_count"]).toBe(2);
  });

  it("floors fractional counts to integers (OTLP integer round-trip)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 4.7,
      drainedContinuationCount: 2.9,
    });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(4);
    expect(attrs["queue.drained_continuation_count"]).toBe(2);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-drain");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationQueueDrainSpan({
        drainedCount: 1,
        drainedContinuationCount: 0,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.queue\.drain span/);
    expect(logged[0]).toContain("kaboom-drain");
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationQueueDrainSpan({
        drainedCount: 0,
        drainedContinuationCount: 0,
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationFanoutSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes() {},
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException() {},
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits one fanout span with aggregate recipient outcomes and parent trace context", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationFanoutSpan({
      fanoutMode: "all",
      targetSessionKeys: ["agent:main:a", "agent:main:b", "agent:main:c"],
      deliveredCount: 3,
      chainStepRemaining: 8,
      traceparent,
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("continuation.queue.fanout");
    expect(spans[0].options?.traceparent).toBe(traceparent);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["fanout.mode"]).toBe("all");
    expect(attrs["fanout.recipient_count"]).toBe(3);
    expect(attrs["fanout.delivered_count"]).toBe(3);
    expect(attrs["fanout.recipient.session_keys"]).toEqual([
      "agent:main:a",
      "agent:main:b",
      "agent:main:c",
    ]);
    expect(attrs["fanout.recipient.outcomes"]).toEqual(["delivered", "delivered", "delivered"]);
    expect(attrs["chain.step.remaining"]).toBe(8);
    expect(spans[0].statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(spans[0].ended).toBe(true);
  });

  it("omits traceparent when mercy-cap forwarding is disabled", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationFanoutSpan({
      fanoutMode: "tree",
      targetSessionKeys: ["agent:main:a", "agent:main:b"],
      deliveredCount: 2,
      chainStepRemaining: 0,
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].options?.traceparent).toBeUndefined();
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["chain.step.remaining"]).toBe(0);
  });
});

describe("continuation-tracer :: emitContinuationCompactionReleasedSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.compaction.released span with canonical attrs (happy path)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3, compactionId: 1 });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("continuation.compaction.released");
    expect(span.options?.attributes).toEqual({
      "signal.kind": "compaction-release",
      "compaction.released": 3,
      "compaction.id": 1,
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("emits span with compaction.released: 0 on zero-release (compaction event still recorded)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 0, compactionId: 2 });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.released"]).toBe(0);
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.id"]).toBe(2);
  });

  it("floors fractional releasedCount to integer (OTLP integer round-trip)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3.7 });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["compaction.released"]).toBe(3);
  });

  it("clamps negative releasedCount to 0 (defense-in-depth)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: -1 });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["compaction.released"]).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-compaction");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationCompactionReleasedSpan({
        releasedCount: 1,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.compaction\.released span/);
    expect(logged[0]).toContain("kaboom-compaction");
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() => emitContinuationCompactionReleasedSpan({ releasedCount: 0 })).not.toThrow();
  });
});

describe("continuation-tracer :: CONTINUATION_SIGNAL_KINDS SSOT pin", () => {
  it("SSOT array has exactly 6 members with the canonical values", () => {
    expect(CONTINUATION_SIGNAL_KINDS).toHaveLength(6);
    expect([...CONTINUATION_SIGNAL_KINDS]).toEqual([
      "work",
      "bracket-work",
      "bracket-delegate",
      "tool-delegate",
      "compaction-release",
      "heartbeat",
    ]);
  });

  it("ContinuationSignalKind union covers all SSOT members (type-level pin)", () => {
    // Compile-time pin: every SSOT member must be assignable to
    // ContinuationSignalKind. If a member is added to the const array
    // without updating the derived type, this block would fail typecheck
    // (the derived type auto-tracks, so this tests the derivation).
    const kinds: ContinuationSignalKind[] = [...CONTINUATION_SIGNAL_KINDS];
    expect(kinds).toHaveLength(6);
  });

  it("ContinuationDisabledSignalKind narrows to exactly 3 disabled-span signal kinds (type-level pin)", () => {
    // Compile-time pin: Extract<> narrows to exactly the 3 disabled-span signal kinds.
    const disabled: ContinuationDisabledSignalKind[] = [
      "bracket-work",
      "bracket-delegate",
      "tool-delegate",
    ];
    expect(disabled).toHaveLength(3);
    // Runtime confirmation: these are a subset of CONTINUATION_SIGNAL_KINDS.
    for (const d of disabled) {
      expect(CONTINUATION_SIGNAL_KINDS).toContain(d);
    }
    // "work", "compaction-release", and "heartbeat" must NOT be assignable to ContinuationDisabledSignalKind.
    // This is a compile-time invariant; the runtime assertion below is a belt-and-suspenders
    // guard that the Extract<> narrows correctly.
    const disabledSet = new Set<string>(disabled);
    expect(disabledSet.has("work")).toBe(false);
    expect(disabledSet.has("compaction-release")).toBe(false);
    expect(disabledSet.has("heartbeat")).toBe(false);
  });
});

describe("continuation-tracer :: compaction.id cross-cutting attr", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("happy: compactionId 7 + releasedCount 3 emits both attrs with signal.kind", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3, compactionId: 7 });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(3);
    expect(attrs["compaction.id"]).toBe(7);
  });

  it("compactionId 1 lower bound emits compaction.id: 1", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 1, compactionId: 1 });
    expect((spans[0].options?.attributes as ContinuationSpanAttrs)["compaction.id"]).toBe(1);
  });

  it("compactionId 0 ordinal-valid: emits compaction.id: 0 (NOT clamped, NOT dropped)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 0, compactionId: 0 });
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.id"]).toBe(0);
    // Signal.kind and compaction.released still present.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(0);
  });

  it("invariant non-integer: compactionId 7.9 drops attr, logs warning, span survives", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 2,
      compactionId: 7.9,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    // compaction.id dropped due to non-integer invariant.
    expect(attrs["compaction.id"]).toBeUndefined();
    // Span still has signal.kind + compaction.released.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(2);
    // Log callback received warning.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invalid compaction.id");
    expect(logged[0]).toContain("7.9");
  });

  it("invariant negative: compactionId -1 drops attr, logs warning, span survives", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 1,
      compactionId: -1,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    // compaction.id dropped due to negative invariant.
    expect(attrs["compaction.id"]).toBeUndefined();
    // Span survives with signal.kind + compaction.released.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(1);
    expect(attrs["compaction.id"]).toBeUndefined();
    // Log callback received warning.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invalid compaction.id");
    expect(logged[0]).toContain("-1");
  });

  it("compactionId omitted (undefined) silently omits attr without logging", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 1,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = spans[0].options?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.id"]).toBeUndefined();
    expect(attrs["signal.kind"]).toBe("compaction-release");
    // No log emitted — undefined is a valid "not provided" sentinel.
    expect(logged).toHaveLength(0);
  });

  // Producer-side invariant pin: incrementRunCompactionCount (session-run-accounting.ts)
  // returns `number | undefined`. When defined, the value is computed as
  // `Math.max(0, entry.compactionCount ?? 0) + Math.max(0, amount)` where amount >= 1
  // at the agent-runner callsite (amount: autoCompactionCount, guarded by `> 0`).
  // This means defined-return is always integer >= 1.
  //
  // The test below pins the helper's acceptance of the producer range, so if the
  // producer contract ever drifts (e.g. returning 0 from a different path), the
  // validate-and-drop boundary tests above catch the mismatch.
  it("producer-side pin: compactionId values in producer range [1..N] are all accepted", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const id of [1, 2, 10, 100]) {
      emitContinuationCompactionReleasedSpan({ releasedCount: 1, compactionId: id });
    }
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      const attrs = span.options?.attributes as ContinuationSpanAttrs;
      expect(typeof attrs["compaction.id"]).toBe("number");
      expect(Number.isInteger(attrs["compaction.id"])).toBe(true);
      expect(attrs["compaction.id"]).toBeGreaterThanOrEqual(1);
    }
  });

  // Producer-coupling pin: invoke incrementRunCompactionCount with a stub
  // session-store, capture the returned `count`, and assert it flows through
  // to attrs["compaction.id"]. The sampled-range test above pins the helper
  // accepts the producer's documented range; this test pins the *call-site*
  // contract — if the producer ever returns a value the helper would drop
  // (0, fractional, negative, undefined-on-error), the assertion fails with
  // a precise message identifying which side broke.
  //
  // Stub keeps storePath undefined to avoid file IO; cfg undefined to skip
  // lifecycle hooks. Only the count-arithmetic path is exercised.
  it("producer-coupling: incrementRunCompactionCount return value flows to compaction.id attr", async () => {
    const { incrementRunCompactionCount } =
      await import("../auto-reply/reply/session-run-accounting.js");
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    const sessionKey = "agent:main:test";
    const baseEntry = {
      sessionId: "s1",
      sessionFile: "/tmp/sessions/s1.jsonl",
      compactionCount: 0,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof incrementRunCompactionCount>[0]["sessionEntry"];
    const sessionStore: Record<string, NonNullable<typeof baseEntry>> = {
      [sessionKey]: baseEntry as NonNullable<typeof baseEntry>,
    };

    // amount=1: producer returns 1 (0 + max(0,1))
    const count1 = await incrementRunCompactionCount({
      sessionEntry: baseEntry,
      sessionStore,
      sessionKey,
      amount: 1,
    });
    expect(count1).toBe(1);
    // releasedCount intentionally 0; this test pins compaction.id flow only.
    emitContinuationCompactionReleasedSpan({
      releasedCount: 0,
      compactionId: count1,
    });

    // amount=3: producer returns 4 (1 + max(0,3)) — sanity-check non-1 increments
    const count3 = await incrementRunCompactionCount({
      sessionEntry: sessionStore[sessionKey],
      sessionStore,
      sessionKey,
      amount: 3,
    });
    expect(count3).toBe(4);
    emitContinuationCompactionReleasedSpan({
      releasedCount: 0,
      compactionId: count3,
    });

    expect(spans).toHaveLength(2);
    const attrs1 = spans[0]?.options?.attributes as ContinuationSpanAttrs;
    const attrs2 = spans[1]?.options?.attributes as ContinuationSpanAttrs;
    expect(attrs1["compaction.id"]).toBe(count1);
    expect(attrs2["compaction.id"]).toBe(count3);
  });
});
