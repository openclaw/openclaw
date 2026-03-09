import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTurnMarker } from "./active-turns.js";

// Mock active-turns before importing watchdog.
const mockLoadMarkers = vi.fn<() => Promise<ActiveTurnMarker[]>>().mockResolvedValue([]);
const mockRemoveMarker = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock("./active-turns.js", () => ({
  loadActiveTurnMarkers: (...args: unknown[]) => mockLoadMarkers(...(args as [])),
  removeActiveTurnMarker: (id: string) => mockRemoveMarker(id),
}));

// Mock embedded runs.
const mockIsActive = vi.fn<(id: string) => boolean>().mockReturnValue(false);
const mockAbort = vi.fn<(id: string) => boolean>().mockReturnValue(true);
vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  isEmbeddedPiRunActive: (id: string) => mockIsActive(id),
  abortEmbeddedPiRun: (id: string) => mockAbort(id),
}));

// Mock logger.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { startStuckTurnWatchdog } = await import("./stuck-turn-watchdog.js");

describe("stuck-turn-watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when no markers exist", async () => {
    mockLoadMarkers.mockResolvedValue([]);
    const handle = startStuckTurnWatchdog({
      deps: {} as never,
      checkIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(mockAbort).not.toHaveBeenCalled();
    handle.stop();
  });

  it("cleans stale markers (no in-memory run)", async () => {
    mockLoadMarkers.mockResolvedValue([
      { sessionId: "stale-1", sessionKey: "key-1", startedAt: Date.now() - 5000 },
    ]);
    mockIsActive.mockReturnValue(false);

    const handle = startStuckTurnWatchdog({
      deps: {} as never,
      checkIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(mockRemoveMarker).toHaveBeenCalledWith("stale-1");
    expect(mockAbort).not.toHaveBeenCalled();
    handle.stop();
  });

  it("aborts turns exceeding abort threshold", async () => {
    const now = Date.now();
    mockLoadMarkers.mockResolvedValue([
      { sessionId: "stuck-1", sessionKey: "key-1", startedAt: now - 1_300_000 },
    ]);
    mockIsActive.mockReturnValue(true);

    const handle = startStuckTurnWatchdog({
      deps: {} as never,
      checkIntervalMs: 1000,
      abortAfterMs: 1_200_000,
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(mockAbort).toHaveBeenCalledWith("stuck-1");
    handle.stop();
  });

  it("does not abort turns within warn threshold", async () => {
    const now = Date.now();
    mockLoadMarkers.mockResolvedValue([
      { sessionId: "ok-1", sessionKey: "key-1", startedAt: now - 300_000 },
    ]);
    mockIsActive.mockReturnValue(true);

    const handle = startStuckTurnWatchdog({
      deps: {} as never,
      checkIntervalMs: 1000,
      warnAfterMs: 600_000,
      abortAfterMs: 1_200_000,
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(mockAbort).not.toHaveBeenCalled();
    handle.stop();
  });

  it("stop() clears the interval", async () => {
    const handle = startStuckTurnWatchdog({
      deps: {} as never,
      checkIntervalMs: 1000,
    });
    handle.stop();

    mockLoadMarkers.mockResolvedValue([{ sessionId: "s1", sessionKey: "k1", startedAt: 0 }]);
    mockIsActive.mockReturnValue(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockLoadMarkers).not.toHaveBeenCalled();
  });
});
