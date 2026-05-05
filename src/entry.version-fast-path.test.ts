import { describe, expect, it, vi } from "vitest";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";

vi.mock("./cli/argv.js", () => ({
  isRootHelpInvocation: () => false,
  isRootVersionInvocation: (argv: string[]) => argv.includes("--version"),
}));

vi.mock("./cli/container-target.js", () => ({
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
  resolveCliContainerTarget: (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
    argv.includes("--container") ? "demo" : (env.OPENCLAW_CONTAINER ?? null),
}));

describe("entry root version fast path", () => {
  it("prints version output and skips host handling when container-targeted", async () => {
    const output = vi.fn();
    const exit = vi.fn();
    const resolveVersion = vi.fn<
      () => Promise<{
        VERSION: string;
        resolveCommitHash: (params: { moduleUrl: string }) => string | null;
      }>
    >(async () => ({
      VERSION: "9.9.9-test",
      resolveCommitHash: vi.fn(() => "abc1234"),
    }));

    await expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).resolves.toBe(true);
    expect(output).toHaveBeenCalledWith("OpenClaw 9.9.9-test (abc1234)");
    expect(exit).toHaveBeenCalledWith(0);

    output.mockClear();
    exit.mockClear();
    resolveVersion.mockResolvedValueOnce({
      VERSION: "9.9.9-test",
      resolveCommitHash: vi.fn(() => null),
    });

    await expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).resolves.toBe(true);
    expect(output).toHaveBeenCalledWith("OpenClaw 9.9.9-test");
    expect(exit).toHaveBeenCalledWith(0);

    output.mockClear();
    exit.mockClear();
    await expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--container", "demo", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).resolves.toBe(false);
    expect(resolveVersion).toHaveBeenCalledTimes(2);
    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        env: { OPENCLAW_CONTAINER: "demo" },
        output,
        exit,
        resolveVersion,
      }),
    ).resolves.toBe(false);
  });
});
