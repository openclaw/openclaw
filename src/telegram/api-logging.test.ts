import { describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";

describe("withTelegramApiErrorLogging", () => {
  it("suppresses benign reaction not-found errors for reaction operation", async () => {
    const logger = vi.fn<(message: string) => void>();

    await expect(
      withTelegramApiErrorLogging({
        operation: "reaction",
        logger,
        fn: async () => {
          throw new Error(
            "Call to 'setMessageReaction' failed! (400: Bad Request: message to react not found)",
          );
        },
      }),
    ).rejects.toThrow("message to react not found");

    expect(logger).not.toHaveBeenCalled();
  });

  it("respects shouldLog and suppresses REACTION_INVALID telemetry noise", async () => {
    const logger = vi.fn<(message: string) => void>();

    await expect(
      withTelegramApiErrorLogging({
        operation: "reaction",
        logger,
        shouldLog: (err) => !/REACTION_INVALID/i.test(String(err)),
        fn: async () => {
          throw new Error(
            "Call to 'setMessageReaction' failed! (400: Bad Request: REACTION_INVALID)",
          );
        },
      }),
    ).rejects.toThrow("REACTION_INVALID");

    expect(logger).not.toHaveBeenCalled();
  });

  it("logs non-suppressed errors", async () => {
    const logger = vi.fn<(message: string) => void>();

    await expect(
      withTelegramApiErrorLogging({
        operation: "reaction",
        logger,
        fn: async () => {
          throw new Error("Call to 'setMessageReaction' failed! (403: Forbidden)");
        },
      }),
    ).rejects.toThrow("403: Forbidden");

    expect(logger).toHaveBeenCalledTimes(1);
  });
});
