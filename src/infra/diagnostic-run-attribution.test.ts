import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDiagnosticClientContext } from "./diagnostic-client-context.js";
import { setDiagnosticsEnabledForProcess } from "./diagnostic-events.js";
import {
  clearRunClientContext,
  getRunClientContext,
  resetRunClientContextForTest,
  setRunClientContext,
} from "./diagnostic-run-attribution.js";

const CTX = normalizeDiagnosticClientContext({ agentId: "Conductor" });

describe("diagnostic run-attribution registry", () => {
  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetRunClientContextForTest();
  });

  afterEach(() => {
    resetRunClientContextForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("resolves a run's context by its runId", () => {
    setRunClientContext("run-1", CTX);
    expect(getRunClientContext("run-1")).toEqual(CTX);
  });

  it("keeps differently attributed runs isolated", () => {
    const other = normalizeDiagnosticClientContext({ agentId: "Soloist" });
    setRunClientContext("run-A", CTX);
    setRunClientContext("run-B", other);
    expect(getRunClientContext("run-A")).toEqual(CTX);
    expect(getRunClientContext("run-B")).toEqual(other);
  });

  it("does not capture context when diagnostics are disabled", () => {
    setDiagnosticsEnabledForProcess(false);
    setRunClientContext("run-1", CTX);
    expect(getRunClientContext("run-1")).toBeUndefined();
  });

  it("treats a missing or empty runId as no context", () => {
    expect(getRunClientContext(undefined)).toBeUndefined();
    expect(getRunClientContext("")).toBeUndefined();
    setRunClientContext("", CTX);
    expect(getRunClientContext("")).toBeUndefined();
  });

  it("drops an entry on clear and on an undefined re-seed", () => {
    setRunClientContext("run-1", CTX);
    clearRunClientContext("run-1");
    expect(getRunClientContext("run-1")).toBeUndefined();

    setRunClientContext("run-2", CTX);
    setRunClientContext("run-2", undefined);
    expect(getRunClientContext("run-2")).toBeUndefined();
  });

  it("evicts the oldest entry past the size cap so the map stays bounded", () => {
    // Seed more than the cap; the earliest runIds should be evicted while the
    // most recent remain resolvable.
    const total = 1100;
    for (let i = 0; i < total; i += 1) {
      setRunClientContext(`run-${i}`, CTX);
    }
    expect(getRunClientContext("run-0")).toBeUndefined();
    expect(getRunClientContext(`run-${total - 1}`)).toEqual(CTX);
  });
});
