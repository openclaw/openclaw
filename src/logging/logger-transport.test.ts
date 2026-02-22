import { describe, expect, it } from "vitest";
import type { LogTransport } from "./logger.js";

const EXTERNAL_TRANSPORTS_KEY = Symbol.for("openclaw.logging.externalTransports");

describe("registerLogTransport global sharing", () => {
  it("externalTransports is stored on globalThis via Symbol.for", () => {
    // Importing logger.ts should have populated the global key.
    const g = globalThis as typeof globalThis & {
      [key: symbol]: Set<LogTransport> | undefined;
    };
    expect(g[EXTERNAL_TRANSPORTS_KEY]).toBeInstanceOf(Set);
  });

  it("registerLogTransport adds to the shared global Set", async () => {
    const { registerLogTransport } = await import("./logger.js");

    const g = globalThis as typeof globalThis & {
      [key: symbol]: Set<LogTransport> | undefined;
    };
    const set = g[EXTERNAL_TRANSPORTS_KEY]!;
    const sizeBefore = set.size;

    const transport: LogTransport = () => {};
    const unregister = registerLogTransport(transport);

    expect(set.size).toBe(sizeBefore + 1);
    expect(set.has(transport)).toBe(true);

    unregister();

    expect(set.has(transport)).toBe(false);
  });
});
