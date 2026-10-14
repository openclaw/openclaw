import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { updateCommand } from "./update-command.js";
import { updateWizardCommand } from "./wizard.js";

vi.mock("@clack/prompts", () => ({ confirm: async () => true, isCancel: () => false }));
vi.mock("../../../packages/terminal-core/src/prompt-select-styled.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../packages/terminal-core/src/prompt-select-styled.js")
  >()),
  selectStyled: async () => "stable",
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ valid: false }),
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallIdentity: async () => ({ installKind: "package" }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  parseUpdateTimeoutMs: () => undefined,
  resolveUpdateRoot: async () => "/fixture/openclaw",
  resolveGitInstallDir: () => "/fixture/git",
  isEmptyDir: async () => true,
  isGitCheckout: async () => false,
}));
// mock-isolation: Exercise wizard delegation without loading the updater activation, ledger, and runtime-retirement owners.
vi.mock("./update-command.js", () => ({ updateCommand: vi.fn() }));

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (stdinTty) {
    Object.defineProperty(process.stdin, "isTTY", stdinTty);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

it.each([0, 1, 23])("preserves an already-reported delegated exit %s", async (code) => {
  const outcome = new ExitError(code);
  vi.mocked(updateCommand).mockRejectedValueOnce(outcome);
  await expect(updateWizardCommand()).rejects.toBe(outcome);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
});

it("still reports an unexpected delegated failure", async () => {
  vi.mocked(updateCommand).mockRejectedValueOnce(new Error("update unavailable"));
  await expect(updateWizardCommand()).rejects.toEqual(new ExitError(1));
  expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("update unavailable");
});
