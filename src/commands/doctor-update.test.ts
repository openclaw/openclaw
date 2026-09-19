import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery.js";
import { withUpdateInProgressEnv } from "../cli/update-cli/update-command-service-env.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const mocks = vi.hoisted(() => ({
  updateCommand: vi.fn<typeof import("../cli/update-cli/update-command.js").updateCommand>(),
  git: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  confirm: vi.fn<(params: { message: string; initialValue: boolean }) => Promise<boolean>>(),
  outro: vi.fn<(message: string) => void>(),
  note: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command.js", () => ({ updateCommand: mocks.updateCommand }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.git,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const result = (status: UpdateRunResult["status"]): UpdateRunResult => ({
  status,
  mode: "git",
  root: "/repo/source",
  steps: [],
  durationMs: 0,
});
function offer(overrides: Partial<Parameters<typeof maybeOfferUpdateBeforeDoctor>[0]> = {}) {
  return maybeOfferUpdateBeforeDoctor({
    options: {},
    root: "/repo/source",
    confirm: mocks.confirm,
    outro: mocks.outro,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
  mocks.git.mockResolvedValue({
    code: 0,
    stdout: "/repo/source\n",
    stderr: "",
    killed: false,
    signal: null,
    termination: "exit",
  });
  mocks.confirm.mockResolvedValue(true);
  mocks.updateCommand.mockImplementation(async ({ onResult }) => {
    onResult?.(result("ok"));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (stdinIsTty) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTty);
  } else {
    delete (process.stdin as Partial<typeof process.stdin>).isTTY;
  }
});

describe("Doctor source update delegation", () => {
  it.each(["OPENCLAW_SUPERVISOR_MODE", "OPENCLAW_SERVICE_REPAIR_POLICY"])(
    "continues Doctor without offering self-update when %s is external",
    async (key) => {
      vi.stubEnv(key, "external");
      await expect(offer()).resolves.toEqual({ updated: false });
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.updateCommand).not.toHaveBeenCalled();
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("external supervisor's stop/update/finalize/restart workflow"),
        "Update",
      );
      expect(mocks.outro).not.toHaveBeenCalled();
    },
  );
  it.each(["nonInteractive", "yes", "repair", "non-TTY", "missing root"] as const)(
    "does not offer an update for %s",
    async (gate) => {
      if (gate === "non-TTY") {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
      }
      const options =
        gate === "nonInteractive" || gate === "yes" || gate === "repair" ? { [gate]: true } : {};
      await expect(
        offer({ options, ...(gate === "missing root" ? { root: null } : {}) }),
      ).resolves.toEqual({ updated: false });
      expect(mocks.git).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.updateCommand).not.toHaveBeenCalled();
    },
  );

  it("does not recurse when the canonical updater runs candidate Doctor", async () => {
    mocks.updateCommand.mockImplementation(async ({ onResult }) => {
      await withUpdateInProgressEnv(process.cwd(), async () => {
        await expect(offer()).resolves.toEqual({ updated: false });
      });
      onResult?.(result("ok"));
    });
    await expect(offer()).resolves.toEqual({ updated: true, handled: true });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.updateCommand).toHaveBeenCalledOnce();
    expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
  });

  it("leaves a declined update with Doctor", async () => {
    mocks.confirm.mockResolvedValue(false);
    await expect(offer()).resolves.toEqual({ updated: false });
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    expect(mocks.updateCommand).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalled();
  });

  it.each([
    { status: "ok", reason: undefined, handled: true },
    { status: "skipped", reason: "already-current", handled: false },
    { status: "skipped", reason: "gateway-readiness-unverified", handled: true },
    { status: "skipped", reason: "still-starting", handled: true },
  ] as const)(
    "uses the settled $status/$reason update outcome to decide whether Doctor continues",
    async ({ status, reason, handled }) => {
      mocks.updateCommand.mockImplementation(async ({ onResult }) => {
        expect(mocks.outro).not.toHaveBeenCalled();
        onResult?.({ ...result(status), reason });
      });
      await expect(offer()).resolves.toEqual({
        updated: true,
        handled,
        ...(reason === "gateway-readiness-unverified" || reason === "still-starting"
          ? { reason }
          : {}),
      });
      expect(mocks.updateCommand).toHaveBeenCalledExactlyOnceWith({
        sourceUpdate: { root: "/repo/source" },
        timeout: "1200",
        onResult: expect.any(Function),
      });
      if (reason === "gateway-readiness-unverified" || reason === "still-starting") {
        expect(mocks.outro).toHaveBeenCalledWith(
          expect.stringContaining("Gateway readiness remains unverified. Keep recovery backups"),
        );
      } else if (status === "ok") {
        expect(mocks.outro).toHaveBeenCalledWith(
          "Update completed (doctor already ran as part of the update).",
        );
      } else {
        expect(mocks.outro).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    new Error("candidate preparation failed"),
    new UpdateCommandRecoveryPendingError("native settlement remains pending"),
  ])("propagates the canonical failure without declaring Doctor handled: %s", async (failure) => {
    mocks.updateCommand.mockImplementation(async ({ onResult }) => {
      onResult?.(result("error"));
      throw failure;
    });
    await expect(offer()).rejects.toBe(failure);
    expect(mocks.outro).not.toHaveBeenCalled();
  });

  it("does not claim completion without a canonical result", async () => {
    mocks.updateCommand.mockResolvedValue(undefined);
    await expect(offer()).resolves.toEqual({ updated: true, handled: false });
    expect(mocks.outro).not.toHaveBeenCalled();
  });

  it("offers a linked source install when checkout realpaths match", async () => {
    vi.mocked(fs.realpath).mockImplementation(async (candidate) =>
      String(candidate) === "/repo/link" ? "/repo/source" : String(candidate),
    );
    await expect(offer({ root: "/repo/link" })).resolves.toEqual({ updated: true, handled: true });
    expect(mocks.updateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUpdate: { root: "/repo/link" } }),
    );
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it.each(["another checkout", "not a repository"])(
    "keeps package-manager guidance for %s",
    async (kind) => {
      mocks.git.mockResolvedValue({
        code: kind === "another checkout" ? 0 : 128,
        stdout: "/repo/other\n",
        stderr: kind === "not a repository" ? "fatal: not a git repository" : "",
        killed: false,
        signal: null,
        termination: "exit",
      });
      await expect(offer()).resolves.toEqual({ updated: false });
      expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining("openclaw update"), "Update");
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.updateCommand).not.toHaveBeenCalled();
    },
  );

  it.each(["missing git", "inspection failed"])(
    "avoids misleading package guidance when %s",
    async (kind) => {
      if (kind === "missing git") {
        mocks.git.mockRejectedValue(new Error("spawn git ENOENT"));
      } else {
        mocks.git.mockResolvedValue({
          code: 128,
          stdout: "",
          stderr: "permission denied",
          killed: false,
          signal: null,
          termination: "exit",
        });
      }
      await expect(offer()).resolves.toEqual({ updated: false });
      expect(mocks.note).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.updateCommand).not.toHaveBeenCalled();
    },
  );
});
