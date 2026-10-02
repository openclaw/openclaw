import { afterEach, describe, expect, it, vi } from "vitest";
import { runClawRemoveCli } from "./gateway-remove-cli.js";

const resolveCurrentOpenClawCliInvocation = vi.hoisted(() => vi.fn());
const runCommandBuffered = vi.hoisted(() => vi.fn());
vi.mock("../infra/openclaw-cli-invocation.js", () => ({ resolveCurrentOpenClawCliInvocation }));
vi.mock("../process/exec.js", () => ({ runCommandBuffered }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Claw Remove one-shot CLI", () => {
  it("passes only the agent and canonical digest as argv, with bounded output", async () => {
    resolveCurrentOpenClawCliInvocation.mockImplementation((args) => ({
      command: "/usr/bin/node",
      args: ["/app/openclaw.mjs", ...args],
      cwd: "/app",
      env: { TSX_TSCONFIG_PATH: "/app/tsconfig.json" },
    }));
    runCommandBuffered.mockResolvedValue({
      termination: "exit",
      code: 0,
      stdout: Buffer.from('{"status":"complete"}'),
    });
    const digest = `sha256:${"a".repeat(64)}`;
    expect(await runClawRemoveCli({ agentId: "worker", planIntegrity: digest })).toEqual({
      code: 0,
      payload: { status: "complete" },
    });
    expect(resolveCurrentOpenClawCliInvocation).toHaveBeenCalledWith(
      [
        "claws",
        "remove",
        "worker",
        "--exact-agent-id",
        "--yes",
        "--plan-integrity",
        digest,
        "--json",
      ],
      { moduleUrl: expect.any(String) },
    );
    expect(runCommandBuffered).toHaveBeenCalledWith(
      [
        "/usr/bin/node",
        "/app/openclaw.mjs",
        "claws",
        "remove",
        "worker",
        "--exact-agent-id",
        "--yes",
        "--plan-integrity",
        digest,
        "--json",
      ],
      expect.objectContaining({
        cwd: "/app",
        env: { TSX_TSCONFIG_PATH: "/app/tsconfig.json" },
        timeoutMs: 600_000,
        killProcessTree: true,
        maxOutputBytes: { stdout: 8 * 1024 * 1024, stderr: 64 * 1024 },
      }),
    );
  });

  it("does not leak stderr or malformed child output in errors", async () => {
    resolveCurrentOpenClawCliInvocation.mockReturnValue({
      command: "/usr/bin/node",
      args: ["/app/openclaw.mjs"],
      cwd: "/app",
    });
    runCommandBuffered
      .mockResolvedValueOnce({
        termination: "timeout",
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("private token"),
      })
      .mockResolvedValueOnce({
        termination: "exit",
        code: 1,
        stdout: Buffer.from("private token"),
        stderr: Buffer.from("private token"),
      });
    await expect(runClawRemoveCli({ agentId: "worker" })).rejects.toThrow(
      "The Claw removal command did not complete.",
    );
    await expect(runClawRemoveCli({ agentId: "worker" })).rejects.toThrow(
      "The Claw removal command returned an invalid result.",
    );
  });
});
