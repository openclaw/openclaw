import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

function setIsTty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

describe("createDoctorPrompter", () => {
  const originalIsTty = process.stdin.isTTY;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
  });

  it("applies repair confirmations in non-interactive repair mode", async () => {
    setIsTty(false);

    const prompter = createDoctorPrompter({
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      options: {
        nonInteractive: true,
        repair: true,
      },
    });

    await expect(prompter.confirm({ message: "repair?", initialValue: false })).resolves.toBe(true);
    await expect(
      prompter.confirmRepair({ message: "repair?", initialValue: false }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmSkipInNonInteractive({ message: "repair?", initialValue: false }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmAggressive({ message: "repair?", initialValue: true }),
    ).resolves.toBe(false);
  });
});
