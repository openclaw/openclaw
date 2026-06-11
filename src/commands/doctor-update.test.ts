// Doctor update tests cover pre-doctor update prompts, state files, and declined update flows.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const originalStdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

const mocks = vi.hoisted(() => ({
  createUpdateProgress: vi.fn(),
  note: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../cli/update-cli/progress.js", () => ({
  createUpdateProgress: mocks.createUpdateProgress,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: mocks.runGatewayUpdate,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

async function runOffer(params?: {
  root?: string;
  confirm?: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}): Promise<Awaited<ReturnType<typeof maybeOfferUpdateBeforeDoctor>>> {
  const confirm = params?.confirm ?? vi.fn().mockResolvedValue(false);
  return await maybeOfferUpdateBeforeDoctor({
    runtime: {} as never,
    options: {},
    root: params?.root ?? "/repo/link",
    confirm,
    outro: vi.fn(),
  });
}

beforeEach(async () => {
  mocks.createUpdateProgress.mockReset();
  mocks.createUpdateProgress.mockReturnValue({ progress: {}, stop: vi.fn() });
  mocks.note.mockReset();
  mocks.runCommandWithTimeout.mockReset();
  mocks.runGatewayUpdate.mockReset();
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStdinIsTtyDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTtyDescriptor);
  } else {
    delete (process.stdin as Partial<typeof process.stdin>).isTTY;
  }
});

describe("maybeOfferUpdateBeforeDoctor", () => {
  it("treats a linked package root as a git checkout when realpaths match", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      const value = String(candidate);
      if (value === "/repo/link" || value === "/repo/real") {
        return "/repo/real";
      }
      return value;
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "/repo/real\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    });

    await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({ updated: false });

    expect(confirm).toHaveBeenCalledWith({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("This install is not a git checkout."),
      "Update",
    );
  });

  it("passes step progress to the updater and stops the spinner when the update throws", async () => {
    const stop = vi.fn();
    const progress = {};
    mocks.createUpdateProgress.mockReturnValue({ progress, stop });
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "/repo/link\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    });
    mocks.runGatewayUpdate.mockRejectedValue(new Error("update exploded"));

    const confirm = vi.fn().mockResolvedValue(true);
    await expect(runOffer({ root: "/repo/link", confirm })).rejects.toThrow("update exploded");

    expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining({ progress }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps package-manager guidance when git reports a different checkout", async () => {
    const confirm = vi.fn();
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "/repo/other\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    });

    await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({ updated: false });

    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("This install is not a git checkout."),
      "Update",
    );
  });
});
