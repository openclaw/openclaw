import { afterEach, expect, it, vi } from "vitest";
import { triageGatewayStartupFailure } from "./startup-triage.js";

afterEach(() => {
  vi.doUnmock("../../commands/triage-failure.js");
});

it("leaves startup failure handling intact when an update removed the recovery module", async () => {
  vi.doMock("../../commands/triage-failure.js", () => {
    throw new Error("Recovery module removed by an in-place update");
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await expect(
    triageGatewayStartupFailure(runtime, new Error("configured plugin crashed during startup")),
  ).resolves.toBeUndefined();
  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("Automatic triage could not load:"),
  );
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw triage"));
  expect(runtime.exit).not.toHaveBeenCalled();
});

it.each(["completed", "failed", undefined, "rejected"] as const)(
  "preserves %s triage outcomes",
  async (outcome) => {
    const failure = new Error("triage command failed");
    vi.doMock("../../commands/triage-failure.js", () => ({
      triageAfterFailure: async () => {
        if (outcome === "rejected") {
          throw failure;
        }
        return outcome;
      },
    }));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = triageGatewayStartupFailure(runtime, new Error("startup failed"));
    if (outcome === "rejected") {
      await expect(result).rejects.toBe(failure);
    } else {
      await expect(result).resolves.toBe(outcome);
    }
    expect(runtime.error).not.toHaveBeenCalled();
  },
);
