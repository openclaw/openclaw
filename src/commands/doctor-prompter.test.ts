import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

function setTerminal(isTTY: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
}

const repairPrompt = { message: "Repair fixture?", initialValue: false };
const interactivePrompt = {
  ...repairPrompt,
  initialValue: true,
  requiresInteractiveConfirmation: true,
};
const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

function makePrompter(
  options: Parameters<typeof createDoctorPrompter>[0]["options"],
  terminal = true,
) {
  setTerminal(terminal);
  return createDoctorPrompter({ runtime: runtime(), options });
}

function createRepairPrompter(params?: { force?: boolean }) {
  return makePrompter(
    { repair: true, nonInteractive: true, ...(params?.force ? { force: true } : {}) },
    false,
  );
}

describe("createDoctorPrompter", () => {
  const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  afterEach(() => {
    vi.resetAllMocks();
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  it.each([false, true])(
    "cancels maintenance approval without waiting for input (already aborted=%s)",
    async (alreadyAborted) => {
      setTerminal(true);
      const controller = new AbortController();
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const clack = await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
      confirmMock.mockImplementation(clack.confirm);
      const prompter = createDoctorPrompter({
        runtime: createNonExitingRuntime(),
        options: { repair: true },
        signal: controller.signal,
      });
      if (alreadyAborted) {
        controller.abort();
      }
      try {
        const pending = prompter.confirmRuntimeRepair({
          message: "Repair fixture service?",
          requiresInteractiveConfirmation: true,
          input,
          output,
        });
        controller.abort();
        await expect(pending).resolves.toBe(false);
        if (alreadyAborted) {
          expect(confirmMock).not.toHaveBeenCalled();
        }
      } finally {
        input.destroy();
        output.destroy();
      }
    },
  );

  it("auto-accepts repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(prompter.confirm(repairPrompt)).resolves.toBe(true);
    await expect(prompter.confirmAutoFix(repairPrompt)).resolves.toBe(true);
    await expect(prompter.confirmRuntimeRepair(repairPrompt)).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("requires --force for aggressive repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmAggressiveAutoFix({ ...repairPrompt, initialValue: true }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("refuses interactive-only repairs without a terminal even with --yes", async () => {
    const repair = makePrompter({ yes: true }, false);
    await expect(repair.confirmRuntimeRepair(interactivePrompt)).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("honors interactive consent with force alone: %s", async (approved) => {
    confirmMock.mockResolvedValueOnce(approved);
    const repair = makePrompter({ force: true });
    expect(repair.shouldRepair).toBe(false);
    expect(repair.shouldForce).toBe(true);
    await expect(repair.confirmRuntimeRepair(interactivePrompt)).resolves.toBe(approved);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("keeps skip-in-non-interactive prompts disabled during update-mode repairs", async () => {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    const prompter = createRepairPrompter();

    await expect(prompter.confirmAutoFix(repairPrompt)).resolves.toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({ ...repairPrompt, initialValue: true }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("auto-accepts aggressive repairs only with --force in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter({ force: true });

    await expect(prompter.confirmAggressiveAutoFix(repairPrompt)).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
