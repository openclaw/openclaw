import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { withUpdateInProgressEnv } from "../cli/update-cli/update-command-service-env.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
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

const tty = createCliTtyMock([process.stdin]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

function gitResult(code = 0, stdout = "/repo/source\n", stderr = "") {
  return createCommandResult({ code, stdout, stderr });
}

async function expectSkipped(overrides: Parameters<typeof offer>[0] = {}) {
  await expect(offer(overrides)).resolves.toBe(false);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.updateCommand).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
  tty.set(true);
  vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
  mocks.git.mockResolvedValue(gitResult());
  mocks.confirm.mockResolvedValue(true);
  mocks.updateCommand.mockImplementation(async ({ onResult }) => {
    onResult?.(result("ok"));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  tty.restore();
});

it("reports a host-owned install before Git discovery", async () => {
  const root = tempDirs.make("openclaw-doctor-host-");
  await fs.writeFile(
    path.join(root, "openclaw-install-owner.json"),
    '{"schemaVersion":1,"owner":"macos-app","displayName":"OpenClaw.app","updateHint":"Update OpenClaw.app to update this Gateway."}',
  );
  await expectSkipped({ root, options: { nonInteractive: true } });
  expect(mocks.git).not.toHaveBeenCalled();
  expect(mocks.note).toHaveBeenCalledExactlyOnceWith(
    "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    "Update",
  );
});

it.each(["external", "nonInteractive", "non-TTY", "declined"] as const)(
  "leaves updating to the owner when %s",
  async (gate) => {
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", gate === "external" ? "external" : undefined);
    tty.set(gate !== "non-TTY");
    mocks.confirm.mockResolvedValue(gate !== "declined");
    await expect(
      offer({ options: gate === "nonInteractive" ? { nonInteractive: true } : {} }),
    ).resolves.toBe(false);
    expect(mocks.updateCommand).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalled();
    if (gate === "declined") {
      expect(mocks.confirm).toHaveBeenCalledOnce();
    } else {
      expect(mocks.confirm).not.toHaveBeenCalled();
    }
    if (gate === "external") {
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("external supervisor's stop/update/finalize/restart workflow"),
        "Update",
      );
    } else if (gate !== "declined") {
      expect(mocks.git).not.toHaveBeenCalled();
    }
  },
);

it.each([undefined, "still-starting"] as const)(
  "delegates to the updater without recursion (readiness=%s)",
  async (reason) => {
    mocks.updateCommand.mockImplementation(async ({ onResult }) => {
      expect(mocks.outro).not.toHaveBeenCalled();
      await withUpdateInProgressEnv(process.cwd(), async () => {
        await expect(offer()).resolves.toBe(false);
      });
      onResult?.(reason ? { ...result("skipped"), reason } : result("ok"));
    });
    await expect(offer()).resolves.toBe(true);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.updateCommand).toHaveBeenCalledExactlyOnceWith({
      sourceUpdate: { root: "/repo/source" },
      timeout: "1200",
      onResult: expect.any(Function),
    });
    expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
    if (reason) {
      expect(mocks.outro).toHaveBeenCalledWith(
        expect.stringContaining("Gateway readiness remains unverified. Keep recovery backups"),
      );
    }
  },
);

it.each([
  ["another checkout", gitResult(0, "/repo/other\n"), true],
  ["not a repository", gitResult(128, "/repo/other\n", "fatal: not a git repository"), true],
  ["missing git", new Error("spawn git ENOENT"), false],
  ["inspection failed", gitResult(128, "", "permission denied"), false],
] as const)("keeps package guidance accurate for %s", async (_kind, response, guidance) => {
  if (response instanceof Error) {
    mocks.git.mockRejectedValue(response);
  } else {
    mocks.git.mockResolvedValue(response);
  }
  await expectSkipped();
  if (guidance) {
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining("openclaw update"), "Update");
  } else {
    expect(mocks.note).not.toHaveBeenCalled();
  }
});
