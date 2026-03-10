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

  it("does not expose secretKey in config object", async () => {
    const cfg = readLangfuseConfig({
      LANGFUSE_ENABLED: "1",
      LANGFUSE_HOST: "http://127.0.0.1:3300",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-secret",
    });

    expect("secretKey" in cfg).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain("sk-secret");
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
      LANGFUSE_SECRET_KEY: "sk-test",
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

  it("parses various truthy enabled values", () => {
    for (const val of ["1", "true", "yes", "on"]) {
      expect(readLangfuseConfig({ LANGFUSE_ENABLED: val }).enabled).toBe(true);
    }
    for (const val of ["0", "false", "no", "off", "", undefined]) {
      expect(readLangfuseConfig({ LANGFUSE_ENABLED: val }).enabled).toBe(false);
    }
  });

  it("no-op instrumentation handles do not throw on any operation", async () => {
    const inst = await initializeLangfuse({ LANGFUSE_ENABLED: "0" });
    const traceHandle = inst.startTrace({ name: "noop-test" });
    const spanHandle = traceHandle.span({ name: "child-span" });
    const genHandle = traceHandle.generation({ name: "child-gen" });

    expect(() => traceHandle.update({ foo: "bar" })).not.toThrow();
    expect(() => traceHandle.end({ output: "done" })).not.toThrow();
    expect(() => traceHandle.captureError(new Error("x"))).not.toThrow();
    expect(() => spanHandle.end({ output: "span done" })).not.toThrow();
    expect(() => spanHandle.captureError(new Error("y"))).not.toThrow();
    expect(() => genHandle.end({ output: "gen done" })).not.toThrow();
    expect(() => genHandle.captureError(new Error("z"))).not.toThrow();
  });
});
