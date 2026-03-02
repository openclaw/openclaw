import { describe, expect, it } from "vitest";
import {
  createChildContext,
  createTraceContext,
  currentTraceContext,
  diagnosticTraceStore,
} from "./diagnostic-trace-context.js";

describe("diagnostic-trace-context", () => {
  describe("createTraceContext", () => {
    it("produces a valid root context with 32-char traceId and 16-char spanId", () => {
      const ctx = createTraceContext();
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.parentSpanId).toBeUndefined();
    });

    it("generates unique IDs across calls", () => {
      const a = createTraceContext();
      const b = createTraceContext();
      expect(a.traceId).not.toBe(b.traceId);
      expect(a.spanId).not.toBe(b.spanId);
    });
  });

  describe("createChildContext", () => {
    it("preserves parent traceId and sets parentSpanId", () => {
      const parent = createTraceContext();
      const child = createChildContext(parent);
      expect(child.traceId).toBe(parent.traceId);
      expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(child.spanId).not.toBe(parent.spanId);
      expect(child.parentSpanId).toBe(parent.spanId);
    });

    it("reads parent from AsyncLocalStorage when no explicit parent given", async () => {
      const root = createTraceContext();
      await diagnosticTraceStore.run(root, async () => {
        const child = createChildContext();
        expect(child.traceId).toBe(root.traceId);
        expect(child.parentSpanId).toBe(root.spanId);
      });
    });

    it("creates a new root context when no parent exists anywhere", () => {
      // Outside any diagnosticTraceStore.run(), with no explicit parent
      const ctx = createChildContext();
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.parentSpanId).toBeUndefined();
    });
  });

  describe("currentTraceContext", () => {
    it("returns undefined outside of a store run", () => {
      expect(currentTraceContext()).toBeUndefined();
    });

    it("returns the active context inside a store run", async () => {
      const root = createTraceContext();
      await diagnosticTraceStore.run(root, async () => {
        expect(currentTraceContext()).toBe(root);
      });
    });

    it("returns nested child context after re-wrapping", async () => {
      const root = createTraceContext();
      await diagnosticTraceStore.run(root, async () => {
        expect(currentTraceContext()).toBe(root);
        const child = createChildContext();
        await diagnosticTraceStore.run(child, async () => {
          expect(currentTraceContext()).toBe(child);
          expect(currentTraceContext()?.traceId).toBe(root.traceId);
          expect(currentTraceContext()?.parentSpanId).toBe(root.spanId);
        });
        // After child run completes, parent context is restored
        expect(currentTraceContext()).toBe(root);
      });
    });
  });

  describe("async propagation", () => {
    it("propagates trace context across async boundaries", async () => {
      const root = createTraceContext();
      await diagnosticTraceStore.run(root, async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(currentTraceContext()).toBe(root);

        // Simulate nested async work
        const result = await Promise.resolve().then(() => {
          return currentTraceContext();
        });
        expect(result).toBe(root);
      });
    });
  });
});
