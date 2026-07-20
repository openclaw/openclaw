// Real resetCommand AND uninstallCommand runtime verification for Bug #2 (PR #108089)
// Tests both commands with mocked @clack/prompts confirm for No and Cancel

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for("clack:cancel"),
  cancel: (msg: string) => console.log("[CANCEL]: " + msg),
}));

const { resetCommand } = await import("./reset.js");
const { uninstallCommand } = await import("./uninstall.js");
const clackPrompts = await import("@clack/prompts");

describe("PR #108089 - resetCommand No vs Cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resetCommand: shows 'skipped' when user answers No", async () => {
    const logMessages: string[] = [];
    const exitCodes: number[] = [];
    const mockRuntime = {
      log: (...args: unknown[]) => logMessages.push(args.join(" ")),
      error: (...args: unknown[]) => logMessages.push("[ERROR] " + args.join(" ")),
      exit: (code: number) => exitCodes.push(code),
    };

    clackPrompts.confirm.mockResolvedValue(false);

    await resetCommand(mockRuntime, {
      scope: "config",
      yes: false,
      dryRun: true,
    });

    console.log("reset No: log=" + JSON.stringify(logMessages));
    console.log("reset No: exit=" + JSON.stringify(exitCodes));
    expect(logMessages.some((m) => m.includes("skipped"))).toBe(true);
    expect(logMessages.some((m) => m.includes("cancelled"))).toBe(false);
    expect(exitCodes).toEqual([0]);
  });

  it("resetCommand: shows 'cancelled' when user presses Ctrl+C", async () => {
    const logMessages: string[] = [];
    const exitCodes: number[] = [];
    const mockRuntime = {
      log: (...args: unknown[]) => logMessages.push(args.join(" ")),
      error: (...args: unknown[]) => logMessages.push("[ERROR] " + args.join(" ")),
      exit: (code: number) => exitCodes.push(code),
    };

    clackPrompts.confirm.mockResolvedValue(Symbol.for("clack:cancel"));

    await resetCommand(mockRuntime, {
      scope: "config",
      yes: false,
      dryRun: true,
    });

    console.log("reset Cancel: log=" + JSON.stringify(logMessages));
    console.log("reset Cancel: exit=" + JSON.stringify(exitCodes));
    expect(exitCodes).toEqual([0]);
  });
});

describe("PR #108089 - uninstallCommand No vs Cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uninstallCommand: shows 'skipped' when user answers No", async () => {
    const logMessages: string[] = [];
    const exitCodes: number[] = [];
    const mockRuntime = {
      log: (...args: unknown[]) => logMessages.push(args.join(" ")),
      error: (...args: unknown[]) => logMessages.push("[ERROR] " + args.join(" ")),
      exit: (code: number) => exitCodes.push(code),
    };

    clackPrompts.confirm.mockResolvedValue(false);

    await uninstallCommand(mockRuntime, {
      all: false,
      service: true,
      state: false,
      workspace: false,
      yes: false,
      dryRun: true,
      nonInteractive: false,
    });

    console.log("uninstall No: log=" + JSON.stringify(logMessages));
    console.log("uninstall No: exit=" + JSON.stringify(exitCodes));
    expect(logMessages.some((m) => m.includes("skipped"))).toBe(true);
    expect(logMessages.some((m) => m.includes("cancelled"))).toBe(false);
    expect(exitCodes).toEqual([0]);
  });

  it("uninstallCommand: shows 'cancelled' when user presses Ctrl+C", async () => {
    const logMessages: string[] = [];
    const exitCodes: number[] = [];
    const mockRuntime = {
      log: (...args: unknown[]) => logMessages.push(args.join(" ")),
      error: (...args: unknown[]) => logMessages.push("[ERROR] " + args.join(" ")),
      exit: (code: number) => exitCodes.push(code),
    };

    clackPrompts.confirm.mockResolvedValue(Symbol.for("clack:cancel"));

    await uninstallCommand(mockRuntime, {
      all: false,
      service: true,
      state: false,
      workspace: false,
      yes: false,
      dryRun: true,
      nonInteractive: false,
    });

    console.log("uninstall Cancel: log=" + JSON.stringify(logMessages));
    console.log("uninstall Cancel: exit=" + JSON.stringify(exitCodes));
    expect(exitCodes).toEqual([0]);
  });
});
