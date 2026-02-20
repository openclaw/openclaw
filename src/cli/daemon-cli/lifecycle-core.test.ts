import { describe, expect, it, vi } from "vitest";

// We test the runServiceStart behavior indirectly by verifying the contract:
// when a service is already loaded, `start` should NOT call restart.

describe("runServiceStart idempotency", () => {
  it("does not restart a service that is already loaded", async () => {
    // We need to import after mocking
    const { runServiceStart } = await import("./lifecycle-core.js");

    const restartFn = vi.fn();
    const stopFn = vi.fn();

    const service = {
      label: "TestService",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: vi.fn(),
      uninstall: vi.fn(),
      stop: stopFn,
      restart: restartFn,
      isLoaded: vi.fn().mockResolvedValue(true),
      readCommand: vi.fn(),
      readRuntime: vi.fn(),
    };

    // Suppress stdout by using json mode
    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => ["openclaw gateway install"],
      opts: { json: true },
    });

    expect(restartFn).not.toHaveBeenCalled();
    expect(service.isLoaded).toHaveBeenCalled();
  });
});
