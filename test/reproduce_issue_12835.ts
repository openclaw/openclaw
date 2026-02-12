import { describe, it, expect } from "vitest";
import { isRecoverableTelegramNetworkError } from "../src/telegram/monitor.js";

describe("Issue #12835: Gateway crash on Telegram fetch errors", () => {
  it("should identify fetch failed as a recoverable error", () => {
    const error = new TypeError("fetch failed");
    (error as any).cause = {
      code: "ConnectTimeoutError",
      name: "ConnectTimeoutError",
      message: "Connect Timeout Error",
    };

    // Check if the validation logic accepts this error
    expect(typeof isRecoverableTelegramNetworkError).toBe("function");
    const isRecoverable = isRecoverableTelegramNetworkError(error, { context: "polling" });
    expect(isRecoverable).toBe(true);
  });
});
