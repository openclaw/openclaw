import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctorContributionWithTimeout } from "./doctor-health-contributions.js";

const noteMock = vi.fn();

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => noteMock(...args),
}));

describe("runDoctorContributionWithTimeout", () => {
  const originalTimeout = process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS;

  afterEach(() => {
    noteMock.mockReset();
    if (originalTimeout === undefined) {
      delete process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = originalTimeout;
    }
  });

  it("notes owned timeout failures without swallowing generic errors", async () => {
    process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = "10";

    await expect(
      runDoctorContributionWithTimeout(
        {
          id: "doctor:test-timeout",
          kind: "core",
          surface: "health",
          option: { value: "doctor:test-timeout", label: "Test contribution" },
          source: "doctor",
          run: async () => {
            await new Promise(() => {});
          },
        },
        {} as never,
      ),
    ).resolves.toBeUndefined();

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Test contribution timed out"),
      "Doctor timeout",
    );
  });

  it("rethrows non-timeout contribution failures", async () => {
    process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS = "50";

    await expect(
      runDoctorContributionWithTimeout(
        {
          id: "doctor:test-error",
          kind: "core",
          surface: "health",
          option: { value: "doctor:test-error", label: "Test contribution" },
          source: "doctor",
          run: async () => {
            throw new Error("boom");
          },
        },
        {} as never,
      ),
    ).rejects.toThrow("boom");

    expect(noteMock).not.toHaveBeenCalled();
  });
});
