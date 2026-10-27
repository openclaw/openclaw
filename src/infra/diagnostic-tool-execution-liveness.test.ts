import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createDiagnosticToolExecutionLiveness,
  recordDiagnosticToolExecutionDeadline,
  registerDiagnosticToolExecutionDeadline,
} from "./diagnostic-tool-execution-liveness.js";

it("preserves released deadline callbacks and callers while runtime chunks drain", () => {
  const { context } = resolveGlobalSingleton(
    Symbol.for("openclaw.diagnosticToolExecutionLiveness"),
    () => ({ context: new AsyncLocalStorage<(deadline: number | undefined) => void>() }),
  );
  const releasedRecord = vi.fn();
  context.run(releasedRecord, () => {
    recordDiagnosticToolExecutionDeadline(100);
    expect(registerDiagnosticToolExecutionDeadline(200)).toBeUndefined();
  });
  expect(releasedRecord).toHaveBeenCalledExactlyOnceWith(100);

  const invocation = createDiagnosticToolExecutionLiveness();
  try {
    invocation.run(() => {
      context.getStore()?.(100);
      const release = registerDiagnosticToolExecutionDeadline(200);
      expect(invocation.view.deadlineAtMs).toBe(200);
      release?.();
      expect(invocation.view.deadlineAtMs).toBe(100);
    });
  } finally {
    invocation.close();
  }
});

it("isolates overlapping and nested deadline owners and retires captured continuations", async () => {
  const first = createDiagnosticToolExecutionLiveness();
  const second = createDiagnosticToolExecutionLiveness();
  const gate = Promise.withResolvers<void>();
  try {
    const pending = first.run(async () => {
      recordDiagnosticToolExecutionDeadline(100);
      second.run(() => recordDiagnosticToolExecutionDeadline(200));
      recordDiagnosticToolExecutionDeadline(110);
      await gate.promise;
      recordDiagnosticToolExecutionDeadline(120);
      expect(first.view.deadlineAtMs).toBe(110);
      expect(registerDiagnosticToolExecutionDeadline(300)).toBeTypeOf("function");
      expect(first.view.deadlineAtMs).toBe(110);
    });
    await second.run(async () => {
      await Promise.resolve();
      recordDiagnosticToolExecutionDeadline(210);
      expect(first.view.deadlineAtMs).toBe(110);
      expect(second.view.deadlineAtMs).toBe(210);
    });
    // The caller is outside both invocations, including after their synchronous prefixes.
    recordDiagnosticToolExecutionDeadline(999);
    expect(registerDiagnosticToolExecutionDeadline(999)).toBeUndefined();
    expect(first.view.deadlineAtMs).toBe(110);
    expect(second.view.deadlineAtMs).toBe(210);
    first.close();
    gate.resolve();
    await pending;
    expect(second.view.deadlineAtMs).toBe(210);
  } finally {
    gate.resolve();
    first.close();
    second.close();
  }
});
