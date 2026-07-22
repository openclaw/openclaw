// Doctor embedded-output tests cover real Clack composition.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  maybeOfferUpdateBeforeDoctor: vi.fn().mockResolvedValue({ handled: true }),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
}));

vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: () => ({ confirm: vi.fn() }),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue(null),
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: mocks.maybeOfferUpdateBeforeDoctor,
}));

const { doctorCommand } = await import("./doctor-health.js");

const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  vi.restoreAllMocks();
  if (stdoutIsTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
  } else {
    delete (process.stdout as Partial<typeof process.stdout>).isTTY;
  }
});

describe("doctorCommand embedded output", () => {
  it("keeps real Doctor UI off rich-TTY stdout when uiOutput is stderr", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runtime = {
      log: (message: unknown) => process.stderr.write(`${String(message)}\n`),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;

    await doctorCommand(runtime, {
      nonInteractive: true,
      uiOutput: process.stderr,
    });

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalled();
  });
});
