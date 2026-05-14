import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const spawnSubagentDirectMock = vi.fn();

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

const { handleLongCommand } = await import("./commands-long.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: "/tmp/workspace" });
}

function firstSpawnArg(): Record<string, unknown> {
  const call = spawnSubagentDirectMock.mock.calls[0];
  if (!call) {
    throw new Error("expected spawnSubagentDirect to have been called");
  }
  return call[0] as Record<string, unknown>;
}

describe("handleLongCommand", () => {
  beforeEach(() => {
    spawnSubagentDirectMock.mockReset();
  });

  it("ignores non-/long messages", async () => {
    expect(await handleLongCommand(buildParams("hello there"), true)).toBeNull();
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("ignores /long when text commands are disabled", async () => {
    expect(await handleLongCommand(buildParams("/long do the thing"), false)).toBeNull();
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("ignores /long from unauthorized senders", async () => {
    const params = buildParams("/long do the thing");
    params.command.isAuthorizedSender = false;

    expect(await handleLongCommand(params, true)).toEqual({ shouldContinue: false });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("returns usage when no task is given", async () => {
    const result = await handleLongCommand(buildParams("/long"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /long");
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("passes desktop mode through to the agent", async () => {
    const result = await handleLongCommand(buildParams("/long desktop build the daemon"), true);

    expect(result).toEqual({ shouldContinue: true });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("spawns a detached subagent for the default background mode", async () => {
    spawnSubagentDirectMock.mockResolvedValue({ status: "accepted", runId: "abcdef1234567890" });

    const result = await handleLongCommand(
      buildParams("/long reverse engineer the reMarkable API"),
      true,
    );

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnParams = firstSpawnArg();
    expect(spawnParams.task).toBe("reverse engineer the reMarkable API");
    expect(spawnParams.mode).toBe("run");
    expect(spawnParams.expectsCompletionMessage).toBe(true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Forked to background");
    expect(result?.reply?.text).toContain("abcdef12");
  });

  it("strips an explicit background mode token from the task", async () => {
    spawnSubagentDirectMock.mockResolvedValue({ status: "accepted", runId: "run123" });

    await handleLongCommand(buildParams("/long background crunch the dataset"), true);

    expect(firstSpawnArg().task).toBe("crunch the dataset");
  });

  it("reports a spawn failure back to the sender", async () => {
    spawnSubagentDirectMock.mockResolvedValue({ status: "error", error: "no capacity" });

    const result = await handleLongCommand(buildParams("/long do the work"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("no capacity");
    expect(result?.reply?.isError).toBe(true);
  });
});
