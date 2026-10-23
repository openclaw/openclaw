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

describe("createDoctorPrompter", () => {
  const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    vi.resetAllMocks();
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    vi.unstubAllEnvs();
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

  it.each([
    [false, false, true, false],
    [true, false, true, true],
    [false, true, false, false],
  ])(
    "applies non-interactive repair policy (force=%s, update=%s)",
    async (force, update, runtimeRepair, aggressive) => {
      if (update) {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      }
      const prompter = makePrompter({ repair: true, nonInteractive: true, force }, false);
      await expect(prompter.confirm(repairPrompt)).resolves.toBe(true);
      await expect(prompter.confirmAutoFix(repairPrompt)).resolves.toBe(true);
      await expect(
        prompter.confirmRuntimeRepair({ ...repairPrompt, initialValue: update }),
      ).resolves.toBe(runtimeRepair);
      await expect(
        prompter.confirmAggressiveAutoFix({ ...repairPrompt, initialValue: !force }),
      ).resolves.toBe(aggressive);
      expect(confirmMock).not.toHaveBeenCalled();
    },
  );

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
});
