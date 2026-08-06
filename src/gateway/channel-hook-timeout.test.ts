import { describe, expect, it } from "vitest";
import { raceChannelHookWithTimeout } from "./channel-hook-timeout.js";

describe("raceChannelHookWithTimeout", () => {
  it("returns hook values", async () => {
    await expect(
      raceChannelHookWithTimeout({ timeoutMs: 50, run: async () => "ok" }),
    ).resolves.toEqual({ kind: "value", value: "ok" });
  });

  it("returns hook failures without rejecting", async () => {
    const error = new Error("probe failed");

    await expect(
      raceChannelHookWithTimeout({
        timeoutMs: 50,
        run: async () => {
          throw error;
        },
      }),
    ).resolves.toEqual({ kind: "error", error });
  });

  it("host-bounds a hook that ignores its timeout hint", async () => {
    await expect(
      raceChannelHookWithTimeout({
        timeoutMs: 10,
        run: async () =>
          await new Promise<never>(() => {
            // Simulate a plugin hook that never settles.
          }),
      }),
    ).resolves.toEqual({ kind: "timeout" });
  });
});
