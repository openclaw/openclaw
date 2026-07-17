import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

function frame(params: unknown): NodeInvokeRequestPayload {
  return {
    id: "invoke-pipe-error",
    nodeId: "node-pipe-error",
    command: "agent.cli.claude.run.v1",
    paramsJSON: JSON.stringify(params),
  };
}

function client(): NodeHostClient {
  return {
    async request() {
      return {};
    },
  };
}

describe("Claude CLI node command pipe errors", () => {
  let realChild: import("node:child_process").ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (realChild && !realChild.killed) {
      realChild.kill("SIGKILL");
    }
    realChild = undefined;
    spawnMock.mockReset();
    vi.resetModules();
  });

  it("settles without uncaught pipe errors after real stdout/stderr stream failures", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    realChild = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild as never);
    const { runClaudeCliNodeCommand } = await import("./invoke-agent-cli-claude.js");

    const uncaughtErrors: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaughtErrors.push(error);
    };
    process.on("uncaughtException", onUncaught);
    const request = { argv: ["-p"], idleTimeoutMs: 100, timeoutMs: 5_000 };

    try {
      const run = runClaudeCliNodeCommand({
        client: client(),
        frame: frame(request),
        request,
        argv: [process.execPath, ...request.argv],
        cwd: undefined,
        env: process.env as Record<string, string>,
        timeoutMs: request.timeoutMs,
      });
      await vi.waitFor(() => typeof realChild?.pid === "number");
      realChild.stdout.destroy(new Error("real stdout pipe failure"));
      realChild.stderr.destroy(new Error("real stderr pipe failure"));
      realChild.kill("SIGKILL");

      await expect(run).resolves.toMatchObject({ success: false });
      expect(uncaughtErrors).toEqual([]);
      expect(spawnMock).toHaveBeenCalledOnce();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
