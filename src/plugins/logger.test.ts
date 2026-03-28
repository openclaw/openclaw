import { describe, expect, it, vi } from "vitest";
import { createPluginLoaderLogger } from "./logger.js";

describe("plugins/logger", () => {
  it("forwards logger methods", () => {
    const methods = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logger = createPluginLoaderLogger(methods);

    for (const [method, value] of [
      ["info", "i"],
      ["warn", "w"],
      ["error", "e"],
      ["debug", "d"],
    ] as const) {
      logger[method]?.(value);
      expect(methods[method]).toHaveBeenCalledWith(value);
    }
  });
});
