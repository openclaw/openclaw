import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { createNonExitingRuntime } from "../runtime.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

const ttyMock = createCliTtyMock([process.stdin]);
const repairPrompt = { message: "Repair fixture?", initialValue: false };
const interactivePrompt = {
  ...repairPrompt,
  initialValue: true,
  requiresInteractiveConfirmation: true,
};

function makePrompter(
  options: Parameters<typeof createDoctorPrompter>[0]["options"],
  terminal = true,
  signal?: AbortSignal,
) {
  ttyMock.set(terminal);
  return createDoctorPrompter({ runtime: createNonExitingRuntime(), options, signal });
}

afterEach(() => {
  vi.resetAllMocks();
  ttyMock.restore();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "cancels maintenance approval without waiting for input (already aborted=%s)",
  async (alreadyAborted) => {
    const controller = new AbortController();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const clack = await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
    confirmMock.mockImplementation(clack.confirm);
    const prompter = makePrompter({ repair: true }, true, controller.signal);
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
    expect([
      await prompter.confirm(repairPrompt),
      await prompter.confirmAutoFix(repairPrompt),
      await prompter.confirmRuntimeRepair({ ...repairPrompt, initialValue: update }),
      await prompter.confirmAggressiveAutoFix({ ...repairPrompt, initialValue: !force }),
    ]).toEqual([true, true, runtimeRepair, aggressive]);
    expect(confirmMock).not.toHaveBeenCalled();
  },
);

it("refuses interactive-only repairs without a terminal even with --yes", async () => {
  const repair = makePrompter({ yes: true }, false);
  await expect(repair.confirmRuntimeRepair(interactivePrompt)).resolves.toBe(false);
  expect(confirmMock).not.toHaveBeenCalled();
});

it("requires an explicit interactive choice for an ambiguous repair under --fix", async () => {
  const prompt = {
    message: "Select the default cron partition",
    options: [{ value: "old", label: "Old partition" }],
  };
  const choose = (options: Parameters<typeof makePrompter>[0]) =>
    makePrompter(options).selectRuntimeRepair(prompt, undefined);
  selectMock.mockResolvedValueOnce("old");
  await expect(choose({ repair: true })).resolves.toBe("old");
  for (const options of [{ yes: true }, { repair: true, nonInteractive: true }]) {
    await expect(choose(options)).resolves.toBeUndefined();
  }
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  await expect(choose({ repair: true })).resolves.toBeUndefined();
});

it.each([false, true])("honors interactive consent with force alone: %s", async (approved) => {
  confirmMock.mockResolvedValueOnce(approved);
  const repair = makePrompter({ force: true });
  await expect(repair.confirmRuntimeRepair(interactivePrompt)).resolves.toBe(approved);
});
