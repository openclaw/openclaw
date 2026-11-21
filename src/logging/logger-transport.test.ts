import { describe, expect, it } from "vitest";

describe("logger transport registry", () => {
  it("does not expose production or test log transport registration", async () => {
    const loggerModule = await import("./logger.js");

    expect(
      (loggerModule as unknown as Record<string, unknown>).registerLogTransport,
    ).toBeUndefined();
    expect((loggerModule as unknown as Record<string, unknown>).testApi).toBeUndefined();
  });

  it("does not publish mutable log transport state on a well-known global symbol", async () => {
    await import("./logger.js");

    expect(
      (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[
        Symbol.for("openclaw.logging.transports")
      ],
    ).toBeUndefined();
  });
});
