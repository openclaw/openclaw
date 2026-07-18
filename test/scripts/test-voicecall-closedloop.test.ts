import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MANAGED_COMMAND_TIMEOUT_CODE = "OPENCLAW_MANAGED_COMMAND_TIMEOUT";
const expectedTestFiles = [
  "extensions/voice-call/src/manager.closed-loop.test.ts",
  "extensions/voice-call/src/media-stream.test.ts",
  "extensions/voice-call/index.test.ts",
];
const scriptUrl = pathToFileURL(path.resolve("scripts/test-voicecall-closedloop.mjs")).href;
const { execFileSyncMock, runManagedCommandMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  runManagedCommandMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("../../scripts/lib/managed-child-process.mjs", async () => {
  const actual = await vi.importActual<
    typeof import("../../scripts/lib/managed-child-process.mjs")
  >("../../scripts/lib/managed-child-process.mjs");
  return {
    ...actual,
    MANAGED_COMMAND_TIMEOUT_CODE,
    runManagedCommand: runManagedCommandMock,
  };
});

describe("test-voicecall-closedloop", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("legacy execFileSync path was used");
    });
    runManagedCommandMock.mockReset();
    runManagedCommandMock.mockResolvedValue(0);
  });

  it("runs the current three-file slice through the managed total deadline", async () => {
    await import(scriptUrl);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(runManagedCommandMock).toHaveBeenCalledOnce();
    expect(runManagedCommandMock).toHaveBeenCalledWith({
      args: [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "vitest.config.ts",
        ...expectedTestFiles,
        "--maxWorkers=1",
      ],
      bin: process.execPath,
      shell: false,
      stdio: "inherit",
      timeoutMs: 10 * 60 * 1000,
    });
    for (const file of expectedTestFiles) {
      expect(fs.existsSync(file), file).toBe(true);
    }
  });

  it("reports every selected file when the total deadline expires", async () => {
    runManagedCommandMock.mockRejectedValue(
      Object.assign(new Error("managed command timed out"), {
        code: MANAGED_COMMAND_TIMEOUT_CODE,
      }),
    );

    const error = await import(scriptUrl).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("closed-loop voice-call test slice timed out");
    for (const file of expectedTestFiles) {
      expect((error as Error).message).toContain(file);
    }
  });
});
