import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined via vi.hoisted to avoid TDZ with ESM hoisting.
const { monitorWebProvider, pickProvider, logWebSelfId, monitorTwilio } =
  vi.hoisted(() => {
    return {
      monitorWebProvider: vi.fn().mockResolvedValue(undefined),
      pickProvider: vi.fn().mockResolvedValue("web"),
      logWebSelfId: vi.fn(),
      monitorTwilio: vi.fn().mockResolvedValue(undefined),
    };
  });

vi.mock("../provider-web.js", () => ({
  monitorWebProvider,
  pickProvider,
  logWebSelfId,
}));

vi.mock("../twilio/monitor.js", () => ({
  monitorTwilio,
}));

import { buildProgram } from "./program.js";

describe("CLI relay command (e2e-ish)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs relay in web mode without crashing", async () => {
    const program = buildProgram();
    program.exitOverride(); // throw instead of exiting process on error

    await expect(
      program.parseAsync(["relay", "--provider", "web"], { from: "user" }),
    ).resolves.toBeInstanceOf(Object);

    expect(pickProvider).toHaveBeenCalledWith("web");
    expect(logWebSelfId).toHaveBeenCalledTimes(1);
    expect(monitorWebProvider).toHaveBeenCalledWith(false);
    expect(monitorTwilio).not.toHaveBeenCalled();
  });
});
