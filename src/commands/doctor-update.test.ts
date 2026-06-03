import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const originalStdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalServiceRepairPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
  readGatewayServiceState: vi.fn(),
  restartGatewayService: vi.fn(),
  resolveGatewayService: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: mocks.runGatewayUpdate,
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

async function runOffer(params?: {
  root?: string;
  confirm?: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
}): Promise<Awaited<ReturnType<typeof maybeOfferUpdateBeforeDoctor>>> {
  const confirm = params?.confirm ?? vi.fn().mockResolvedValue(false);
  return await maybeOfferUpdateBeforeDoctor({
    runtime: params?.runtime ?? {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    options: {},
    root: params?.root ?? "/repo/link",
    confirm,
    outro: vi.fn(),
  });
}

beforeEach(async () => {
  mocks.note.mockReset();
  mocks.readGatewayServiceState.mockReset();
  mocks.restartGatewayService.mockReset();
  mocks.resolveGatewayService.mockReset();
  mocks.runCommandWithTimeout.mockReset();
  mocks.runGatewayUpdate.mockReset();
  mocks.resolveGatewayService.mockReturnValue({
    restart: mocks.restartGatewayService,
  });
  mocks.readGatewayServiceState.mockResolvedValue({
    installed: false,
    running: false,
    env: {},
  });
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
  if (originalServiceRepairPolicy === undefined) {
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  } else {
    process.env.OPENCLAW_SERVICE_REPAIR_POLICY = originalServiceRepairPolicy;
  }
});

describe("maybeOfferUpdateBeforeDoctor", () => {
  function mockGitCheckout() {
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
  }

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

  it("restarts a running managed gateway after a successful git update", async () => {
    mockGitCheckout();
    mocks.runGatewayUpdate.mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/repo/link",
    });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      running: true,
      env: { OPENCLAW_PROFILE: "work" },
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(mocks.restartGatewayService).toHaveBeenCalledWith({
      env: { OPENCLAW_PROFILE: "work" },
      stdout: process.stdout,
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Restarted the running gateway service after updating OpenClaw.",
      "Update",
    );
  });

  it("leaves a running gateway alone when service repair is externally managed", async () => {
    mockGitCheckout();
    process.env.OPENCLAW_SERVICE_REPAIR_POLICY = "external";
    mocks.runGatewayUpdate.mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/repo/link",
    });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      running: true,
      env: { OPENCLAW_PROFILE: "work" },
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(mocks.resolveGatewayService).not.toHaveBeenCalled();
    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
    expect(mocks.restartGatewayService).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Update");
  });

  it("stops the parent doctor when the post-update gateway restart fails", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    mockGitCheckout();
    mocks.runGatewayUpdate.mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/repo/link",
    });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      running: true,
      env: { OPENCLAW_PROFILE: "work" },
    });
    mocks.restartGatewayService.mockRejectedValue(new Error("schtasks failed"));

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "Update completed, but gateway service restart failed: Error: schtasks failed",
    );
  });
});
