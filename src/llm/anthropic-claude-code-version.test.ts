import {
  ANTHROPIC_CLAUDE_CODE_VERSION,
  getAnthropicClaudeCodeVersion,
  resetAnthropicClaudeCodeVersionForTests,
  resolveAnthropicClaudeCodeIdentity,
  setAnthropicClaudeCodeVersion,
} from "@openclaw/ai/providers";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import {
  adoptInstalledClaudeCodeVersion,
  parseClaudeCodeVersionOutput,
  resetInstalledClaudeCodeVersionAdoptionForTests,
} from "./anthropic-claude-code-version.js";

afterEach(() => {
  resetAnthropicClaudeCodeVersionForTests();
  resetInstalledClaudeCodeVersionAdoptionForTests();
  runCommandWithTimeoutMock.mockReset();
});

describe("setAnthropicClaudeCodeVersion", () => {
  it("adopts a newer version and reports it", () => {
    expect(setAnthropicClaudeCodeVersion("2.1.273")).toBe(true);
    expect(getAnthropicClaudeCodeVersion()).toBe("2.1.273");
  });

  it("never adopts an older, equal or malformed version", () => {
    expect(setAnthropicClaudeCodeVersion("2.1.10")).toBe(false);
    expect(setAnthropicClaudeCodeVersion(ANTHROPIC_CLAUDE_CODE_VERSION)).toBe(false);
    expect(setAnthropicClaudeCodeVersion("latest")).toBe(false);
    expect(setAnthropicClaudeCodeVersion("")).toBe(false);
    expect(getAnthropicClaudeCodeVersion()).toBe(ANTHROPIC_CLAUDE_CODE_VERSION);
  });

  it("keeps the newest it has seen", () => {
    setAnthropicClaudeCodeVersion("2.1.300");
    expect(setAnthropicClaudeCodeVersion("2.1.273")).toBe(false);
    expect(getAnthropicClaudeCodeVersion()).toBe("2.1.300");
  });
});

describe("parseClaudeCodeVersionOutput", () => {
  it("reads the version off what the CLI prints", () => {
    expect(parseClaudeCodeVersionOutput("2.1.273 (Claude Code)")).toBe("2.1.273");
    expect(parseClaudeCodeVersionOutput("  2.1.74\n")).toBe("2.1.74");
    expect(parseClaudeCodeVersionOutput("Claude Code 2.1.273")).toBeNull();
    expect(parseClaudeCodeVersionOutput("")).toBeNull();
    expect(parseClaudeCodeVersionOutput(null)).toBeNull();
  });
});

describe("adoptInstalledClaudeCodeVersion", () => {
  it("reports the installed version when it is newer than the pinned one", async () => {
    const adopted = await adoptInstalledClaudeCodeVersion({
      probe: async (command) => (command === "claude" ? "2.1.273 (Claude Code)" : null),
    });
    expect(adopted).toBe("2.1.273");
    expect(getAnthropicClaudeCodeVersion()).toBe("2.1.273");
  });

  it("leaves the pinned version when nothing is installed, or what is installed is older", async () => {
    expect(await adoptInstalledClaudeCodeVersion({ probe: async () => null })).toBeNull();
    expect(getAnthropicClaudeCodeVersion()).toBe(ANTHROPIC_CLAUDE_CODE_VERSION);
    resetInstalledClaudeCodeVersionAdoptionForTests();
    expect(
      await adoptInstalledClaudeCodeVersion({ probe: async () => "2.0.1 (Claude Code)" }),
    ).toBeNull();
    expect(getAnthropicClaudeCodeVersion()).toBe(ANTHROPIC_CLAUDE_CODE_VERSION);
  });

  it("falls through to the next command name and survives a probe that throws", async () => {
    const adopted = await adoptInstalledClaudeCodeVersion({
      probe: async (command) => {
        if (command === "claude") {
          throw new Error("ENOENT");
        }
        return "2.1.260";
      },
    });
    expect(adopted).toBe("2.1.260");
  });

  it("makes OAuth requests wait for the probe, so the first one reports the installed version", async () => {
    let answer!: (output: string) => void;
    const probe = () =>
      new Promise<string | null>((resolve) => {
        answer = resolve;
      });
    void adoptInstalledClaudeCodeVersion({ probe });

    let identity: Awaited<ReturnType<typeof resolveAnthropicClaudeCodeIdentity>> | undefined;
    const request = resolveAnthropicClaudeCodeIdentity().then((resolved) => {
      identity = resolved;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(identity).toBeUndefined();

    answer("2.1.273 (Claude Code)");
    await request;
    expect(identity).toMatchObject({
      version: "2.1.273",
      userAgent: "claude-cli/2.1.273",
      billingSystemBlock: "x-anthropic-billing-header: cc_version=2.1.273; cc_entrypoint=sdk-cli;",
    });
  });

  it("runs the default probe through the shared command runner, which launches Windows shims", async () => {
    // A bare execFile cannot start npm's claude.cmd shim on Windows; the
    // command runner owns that launcher handling for the whole repository.
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "2.1.273 (Claude Code)\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    expect(await adoptInstalledClaudeCodeVersion()).toBe("2.1.273");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["claude", "--version"],
      expect.objectContaining({ timeoutMs: 3_000, maxOutputBytes: 16 * 1024 }),
    );
  });

  it("takes the version from the first printed line and does not wait for the CLI to stop", async () => {
    // Some installs keep running after printing their version and are slow to
    // stop; the probe must settle on the printed line, not on the exit.
    let stopped: boolean | void;
    runCommandWithTimeoutMock.mockImplementation((_argv, options) => {
      stopped = options.onOutputChunk?.(Buffer.from("2.1.274 (Claude Code)\n"), "stdout");
      return new Promise(() => {
        // the runner is still stopping the lingering CLI
      });
    });

    expect(await adoptInstalledClaudeCodeVersion()).toBe("2.1.274");
    expect(stopped).toBe(false);
    expect(getAnthropicClaudeCodeVersion()).toBe("2.1.274");
  });

  it("reports nothing when the installed CLI cannot be launched or fails", async () => {
    runCommandWithTimeoutMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "not found",
      code: 127,
      signal: null,
      killed: false,
      termination: "exit",
    });

    expect(await adoptInstalledClaudeCodeVersion()).toBeNull();
    expect(getAnthropicClaudeCodeVersion()).toBe(ANTHROPIC_CLAUDE_CODE_VERSION);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("probes once per process", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return "2.1.273";
    };
    await Promise.all([
      adoptInstalledClaudeCodeVersion({ probe }),
      adoptInstalledClaudeCodeVersion({ probe }),
    ]);
    await adoptInstalledClaudeCodeVersion({ probe });
    expect(calls).toBe(1);
  });
});
