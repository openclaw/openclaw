import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { ExitError } from "../runtime.js";
import { offerInvalidConfigRecovery } from "./invalid-config-recovery.js";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isInteractive: vi.fn(),
  runDoctor: vi.fn(),
}));
vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  promptYesNo: mocks.confirm,
}));
vi.mock("./terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./terminal-interactivity.js")>()),
  isTerminalInteractive: mocks.isInteractive,
}));
// mock-isolation: Consent and retry tests must not initialize Doctor migrations or state admission.
vi.mock("../commands/doctor.js", () => ({ doctorCommand: mocks.runDoctor }));

beforeEach(() => {
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.isInteractive.mockReset().mockReturnValue(true);
  mocks.runDoctor.mockReset().mockResolvedValue(undefined);
});

describe("offerInvalidConfigRecovery", () => {
  it("runs doctor and retries once after interactive consent", async () => {
    const runtime = createTestRuntime();
    const retry = vi.fn(async () => "started");
    await expect(offerInvalidConfigRecovery({ runtime, retry })).resolves.toEqual({
      status: "recovered",
      value: "started",
    });
    expect(mocks.runDoctor).toHaveBeenCalledExactlyOnceWith(runtime, { repair: true });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("prints the command without running doctor when consent is declined", async () => {
    const runtime = createTestRuntime();
    mocks.confirm.mockResolvedValue(false);
    const retry = vi.fn(async () => {});
    await expect(offerInvalidConfigRecovery({ runtime, retry })).resolves.toEqual({
      status: "declined",
    });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("prints only the command in non-interactive mode", async () => {
    const runtime = createTestRuntime();
    mocks.isInteractive.mockReturnValue(false);
    const retry = vi.fn(async () => {});
    await expect(offerInvalidConfigRecovery({ runtime, retry })).resolves.toEqual({
      status: "declined",
    });
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("reports one failed retry without running doctor again", async () => {
    const runtime = createTestRuntime();
    const retry = vi.fn(async () => {
      throw createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: invalid");
    });
    await expect(offerInvalidConfigRecovery({ runtime, retry })).resolves.toEqual({
      status: "retry-failed",
    });
    expect(mocks.runDoctor).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Config is still invalid"));
  });

  it("reports doctor failures without retrying the command", async () => {
    const runtime = createTestRuntime();
    const retry = vi.fn(async () => "started");
    mocks.runDoctor.mockRejectedValue(new Error("repair unavailable"));
    await expect(offerInvalidConfigRecovery({ runtime, retry })).resolves.toEqual({
      status: "retry-failed",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("repair unavailable"));
  });

  it("preserves intentional doctor exits", async () => {
    const runtime = createTestRuntime();
    mocks.runDoctor.mockRejectedValue(new ExitError(2));
    await expect(
      offerInvalidConfigRecovery({ runtime, retry: vi.fn(async () => "started") }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
