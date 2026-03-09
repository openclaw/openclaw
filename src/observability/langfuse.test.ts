import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeLangfuse,
  readLangfuseConfig,
  resetLangfuseInstrumentationForTests,
  startLangfuseTrace,
} from "./langfuse.js";

afterEach(() => {
  resetLangfuseInstrumentationForTests();
  vi.resetModules();
  vi.unmock("langfuse");
});

describe("langfuse observability layer", () => {
  it("parses disabled config and stays in no-op mode", async () => {
    const instrumentation = await initializeLangfuse({ LANGFUSE_ENABLED: "0" });
    const trace = await startLangfuseTrace({ name: "disabled-trace" });

    expect(readLangfuseConfig({ LANGFUSE_ENABLED: "0" }).enabled).toBe(false);
    expect(instrumentation.enabled).toBe(false);
    expect(trace.enabled).toBe(false);
    expect(() => trace.update({ ok: true })).not.toThrow();
    expect(() => trace.end({ status: "ok" })).not.toThrow();
    expect(() => trace.captureError(new Error("boom"))).not.toThrow();
  });

  it("falls back to no-op when enabled but config is incomplete", async () => {
    const instrumentation = await initializeLangfuse({
      LANGFUSE_ENABLED: "1",
      LANGFUSE_HOST: "http://127.0.0.1:3300",
      LANGFUSE_PUBLIC_KEY: "pk-test",
    });

    expect(instrumentation.enabled).toBe(false);
    expect(instrumentation.config.enabled).toBe(true);
    expect(instrumentation.config.configured).toBe(false);
  });

  it("creates callable handles when enabled and configured", async () => {
    const end = vi.fn();
    const update = vi.fn();
    const span = vi.fn(() => ({ end, update, span, generation }));
    const generation = vi.fn(() => ({ end, update, span, generation }));
    const traceNode = { update, span, generation };
    const trace = vi.fn(() => traceNode);

    vi.doMock("langfuse", () => ({
      Langfuse: class {
        trace = trace;
        flushAsync = vi.fn(async () => {});
        shutdownAsync = vi.fn(async () => {});
      },
    }));

    const instrumentation = await initializeLangfuse({
      LANGFUSE_ENABLED: "1",
      LANGFUSE_HOST: "http://127.0.0.1:3300",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test", // pragma: allowlist secret
    });

    const handle = instrumentation.startTrace({ name: "root" });
    const childSpan = handle.span({ name: "tool" });
    const childGeneration = handle.generation({ name: "model" });

    expect(instrumentation.enabled).toBe(true);
    expect(handle.enabled).toBe(true);
    expect(() => handle.update({ output: "ok" })).not.toThrow();
    expect(() => handle.captureError(new Error("trace-error"))).not.toThrow();
    expect(() => childSpan.end({ output: "done" })).not.toThrow();
    expect(() => childGeneration.captureError(new Error("gen-error"))).not.toThrow();
    expect(trace).toHaveBeenCalledOnce();
    expect(span).toHaveBeenCalledOnce();
    expect(generation).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });
});
