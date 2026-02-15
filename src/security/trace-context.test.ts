import { describe, expect, it, beforeEach } from "vitest";
import {
  createTraceId,
  createSpanId,
  createRootTrace,
  createChildSpan,
  formatTraceparent,
  setTraceContextForRun,
  getTraceContextForRun,
  clearTraceContextForRun,
  resetTraceContextForTests,
} from "./trace-context.js";

const HEX_RE = /^[0-9a-f]+$/;

describe("trace-context", () => {
  beforeEach(() => {
    resetTraceContextForTests();
  });

  it("createTraceId returns a 32-char hex string", () => {
    const id = createTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(HEX_RE);
  });

  it("createSpanId returns a 16-char hex string", () => {
    const id = createSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(HEX_RE);
  });

  it("createRootTrace returns a TraceContext with no parentSpanId", () => {
    const root = createRootTrace();
    expect(root.traceId).toHaveLength(32);
    expect(root.spanId).toHaveLength(16);
    expect(root.parentSpanId).toBeUndefined();
  });

  it("createChildSpan preserves traceId, creates new spanId, sets parentSpanId", () => {
    const root = createRootTrace();
    const child = createChildSpan(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).toHaveLength(16);
    expect(child.spanId).not.toBe(root.spanId);
    expect(child.parentSpanId).toBe(root.spanId);
  });

  it("formatTraceparent returns correct W3C format", () => {
    const ctx = createRootTrace();
    const traceparent = formatTraceparent(ctx);
    expect(traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("setTraceContextForRun / getTraceContextForRun round-trip works", () => {
    const ctx = createRootTrace();
    setTraceContextForRun("run-1", ctx);
    expect(getTraceContextForRun("run-1")).toBe(ctx);
  });

  it("getTraceContextForRun returns undefined for unknown runId", () => {
    expect(getTraceContextForRun("unknown")).toBeUndefined();
  });

  it("clearTraceContextForRun removes the entry", () => {
    const ctx = createRootTrace();
    setTraceContextForRun("run-2", ctx);
    clearTraceContextForRun("run-2");
    expect(getTraceContextForRun("run-2")).toBeUndefined();
  });

  it("two successive createSpanId calls return different values", () => {
    const a = createSpanId();
    const b = createSpanId();
    expect(a).not.toBe(b);
  });
});
