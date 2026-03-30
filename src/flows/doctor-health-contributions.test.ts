import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctorContributionWithTimeout } from "./doctor-contribution-timeout.js";

const noteMock = vi.fn();

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => noteMock(...args),
}));

describe("runDoctorContributionWithTimeout", () => {
  const originalTimeout = process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS;

  afterEach(() => {
    vi.useRealTimers();
    noteMock.mockReset();
    if (originalTimeout === undefined) {
      delete process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = originalTimeout;
    }
  });

  it("notes owned timeout failures without swallowing generic errors", async () => {
    // This suite runs in non-isolated workers in CI; force real timers so
    // leftover fake-timer state from earlier files cannot suppress the timeout.
    vi.useRealTimers();
    process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = "10";

    await expect(
      runDoctorContributionWithTimeout(
        {
          id: "doctor:test-timeout",
          option: { label: "Test contribution" },
          run: async () => {
            await new Promise(() => {});
          },
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Test contribution timed out"),
      "Doctor timeout",
    );
  });

  it("rethrows non-timeout contribution failures", async () => {
    vi.useRealTimers();
    process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = "50";

    await expect(
      runDoctorContributionWithTimeout(
        {
          id: "doctor:test-error",
          option: { label: "Test contribution" },
          run: async () => {
            throw new Error("boom");
          },
        },
        {},
      ),
    ).rejects.toThrow("boom");

    expect(noteMock).not.toHaveBeenCalled();
  });
});
