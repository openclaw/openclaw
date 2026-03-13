import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLogTransport, resetLogger, setLoggerOverride } from "./logger.js";

const EXTERNAL_TRANSPORTS_KEY = Symbol.for("openclaw.logging.externalTransports");

afterEach(() => {
  resetLogger();
  setLoggerOverride(null);
  vi.restoreAllMocks();
  const transports = (globalThis as Record<symbol, unknown>)[EXTERNAL_TRANSPORTS_KEY];
  if (transports instanceof Set) {
    transports.clear();
  }
});

describe("registerLogTransport", () => {
  it("stores transports in a process-global registry", () => {
    const transport = vi.fn();
    const unsubscribe = registerLogTransport(transport);

    const transports = (globalThis as Record<symbol, unknown>)[EXTERNAL_TRANSPORTS_KEY];
    expect(transports).toBeInstanceOf(Set);
    expect((transports as Set<unknown>).has(transport)).toBe(true);

    unsubscribe();
    expect((transports as Set<unknown>).has(transport)).toBe(false);
  });
});
