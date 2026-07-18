import type { ExecFileSyncOptions } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

describe("test-voicecall-closedloop", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
  });

  it("enforces a total deadline and reports all target test files", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    execFileSyncMock.mockImplementation(
      (_command: string, _args: readonly string[], options: ExecFileSyncOptions) =>
        actual.execFileSync(process.execPath, ["--eval", "setInterval(() => {}, 1_000)"], {
          ...options,
          stdio: "ignore",
          timeout: 50,
        }),
    );

    const error = await import("../../scripts/test-voicecall-closedloop.mjs").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock.mock.calls[0]?.[2]).toMatchObject({
      killSignal: "SIGTERM",
      timeout: 10 * 60 * 1000,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("closed-loop voice-call test slice timed out");
    expect((error as Error).message).toContain("extensions/voice-call/src/manager.test.ts");
    expect((error as Error).message).toContain("extensions/voice-call/src/media-stream.test.ts");
    expect((error as Error).message).toContain("src/plugins/voice-call.plugin.test.ts");
  });
});
