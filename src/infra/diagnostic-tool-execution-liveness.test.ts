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
