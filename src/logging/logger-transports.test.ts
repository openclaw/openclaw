import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger, registerLogTransport, resetLogger, setLoggerOverride } from "./logger.js";

const EXTERNAL_TRANSPORTS_KEY = Symbol.for("openclaw.logging.externalTransports");
const CACHED_LOGGER_KEY = Symbol.for("openclaw.logging.cachedLogger");

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

  it("attaches transport to already-active logger via globalThis", () => {
    // Simulate openclaw core having already built the logger before the plugin loads.
    setLoggerOverride({ level: "silent" });
    const logger = getLogger();

    // Verify the logger was stored in globalThis (as a plugin module instance would see it).
    const globalLogger = (globalThis as Record<symbol, unknown>)[CACHED_LOGGER_KEY];
    expect(globalLogger).not.toBeNull();

    // Now simulate a plugin registering a transport after the logger is already active.
    // Spy on attachTransport to verify the transport is wired up to the active logger instance.
    const attachSpy = vi.spyOn(logger, "attachTransport");
    const transport = vi.fn();
    registerLogTransport(transport);

    expect(attachSpy).toHaveBeenCalledOnce();
  });
});
