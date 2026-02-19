import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const createClackPrompterMock = vi.hoisted(() => vi.fn());
const runOnboardingWizardMock = vi.hoisted(() => vi.fn());
const restoreTerminalStateMock = vi.hoisted(() => vi.fn());

vi.mock("../wizard/clack-prompter.js", () => ({ createClackPrompter: createClackPrompterMock }));
vi.mock("../wizard/onboarding.js", () => ({ runOnboardingWizard: runOnboardingWizardMock }));
vi.mock("../terminal/restore.js", () => ({ restoreTerminalState: restoreTerminalStateMock }));

import { WizardCancelledError } from "../wizard/prompts.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runInteractiveOnboarding", () => {
  beforeEach(() => {
    createClackPrompterMock.mockReset();
    runOnboardingWizardMock.mockReset();
    restoreTerminalStateMock.mockReset();
    (runtime.log as ReturnType<typeof vi.fn>).mockClear();
    (runtime.error as ReturnType<typeof vi.fn>).mockClear();
    (runtime.exit as ReturnType<typeof vi.fn>).mockClear();

    createClackPrompterMock.mockReturnValue({});
    runOnboardingWizardMock.mockResolvedValue(undefined);
  });

  it("exits with code 1 when the wizard is cancelled", async () => {
    runOnboardingWizardMock.mockRejectedValue(new WizardCancelledError());

    await runInteractiveOnboarding({} as never, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(restoreTerminalStateMock).toHaveBeenCalledWith("onboarding finish", {
      resumeStdinIfPaused: false,
    });
  });

  it("rethrows non-cancel errors", async () => {
    const err = new Error("boom");
    runOnboardingWizardMock.mockRejectedValue(err);

    await expect(runInteractiveOnboarding({} as never, runtime)).rejects.toThrow("boom");

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(restoreTerminalStateMock).toHaveBeenCalledWith("onboarding finish", {
      resumeStdinIfPaused: false,
    });
  });
});
