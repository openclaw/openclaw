import { expect, it } from "vitest";
import {
  createChildDiagnosticTraceContext as child,
  createDiagnosticTraceContext as create,
  createDiagnosticTraceContextFromActiveScope as fromScope,
  freezeDiagnosticTraceContext as freeze,
  formatDiagnosticTraceparent as format,
  getActiveDiagnosticTraceContext as active,
  isValidDiagnosticSpanId as isSpanId,
  isValidDiagnosticTraceId as isTraceId,
  parseDiagnosticTraceparent as parse,
  runWithDiagnosticTraceContext as withTrace,
} from "./diagnostic-trace-context.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "7ad6b9a982deb2c9";
const ROOT = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: "01" };

it("rejects malformed traceparent values", () => {
  expect(parse(undefined)).toBeUndefined();
  expect(parse(`00-xyz-${SPAN_ID}-01`)).toBeUndefined();
  expect(parse(`00-${TRACE_ID}-xyz-01`)).toBeUndefined();
  expect(parse(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeUndefined();
  expect(parse(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
  expect(parse(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
  expect(parse(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
  expect(parse(`00-${TRACE_ID}-${SPAN_ID}-xyz`)).toBeUndefined();
});

it("rejects oversized traceparent values before parsing", () => {
  expect(parse(`00-${TRACE_ID}-${SPAN_ID}-01-${"a".repeat(128)}`)).toBeUndefined();
});

it("creates a normalized context from explicit fields or traceparent", () => {
  expect(
    create({
      traceId: TRACE_ID.toUpperCase(),
      spanId: SPAN_ID.toUpperCase(),
      traceFlags: "00",
    }),
  ).toEqual({ ...ROOT, traceFlags: "00" });
  expect(create({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })).toEqual(ROOT);
});

it("generates valid non-zero ids for fallback contexts", () => {
  const context = create();

  expect(isTraceId(context.traceId)).toBe(true);
  expect(isSpanId(context.spanId)).toBe(true);
  expect(format(context)).toBe(`00-${context.traceId}-${context.spanId}-01`);
});

it("freezes a defensive trace context copy", () => {
  const context = create(ROOT);
  const frozen = freeze(context);

  expect(frozen).toEqual(context);
  expect(frozen).not.toBe(context);
  expect(Object.isFrozen(frozen)).toBe(true);
});

it("carries active trace context across async work and restores outer scopes", async () => {
  const outer = create({ traceId: TRACE_ID, spanId: SPAN_ID });
  const inner = child(outer, { spanId: CHILD_SPAN_ID });

  await withTrace(outer, async () => {
    expect(active()).toEqual(outer);
    await Promise.resolve();
    expect(active()).toEqual(outer);

    withTrace(inner, () => expect(active()).toEqual(inner));

    expect(active()).toEqual(outer);
    await withTrace(undefined, async () => {
      expect(active()).toBeUndefined();
      await Promise.resolve();
      expect(active()).toBeUndefined();
    });
    expect(active()).toEqual(outer);
  });

  expect(active()).toBeUndefined();
});

it("creates child trace contexts from the active request scope", () => {
  const requestTrace = create({ ...ROOT, traceFlags: "00" });

  withTrace(requestTrace, () => {
    expect(fromScope({ spanId: CHILD_SPAN_ID })).toEqual({
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      parentSpanId: SPAN_ID,
      traceFlags: "00",
    });
  });

  expect(fromScope({ spanId: CHILD_SPAN_ID })).toEqual({
    traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    spanId: CHILD_SPAN_ID,
    traceFlags: "01",
  });
});
