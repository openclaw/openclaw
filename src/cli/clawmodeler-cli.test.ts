import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClawModelerEngineArgs, runClawModelerEngine } from "./clawmodeler-cli.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("clawmodeler cli", () => {
  afterEach(() => {
    spawnMock.mockReset();
    process.exitCode = undefined;
  });

  it("builds Python module arguments for the sidecar", () => {
    expect(
      buildClawModelerEngineArgs(["run", "--workspace", "demo", "--run-id", "baseline"]),
    ).toEqual(["-m", "clawmodeler_engine", "run", "--workspace", "demo", "--run-id", "baseline"]);
  });

  it("spawns the Python sidecar with inherited stdio", async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const run = runClawModelerEngine(["doctor", "--json"]);
    child.emit("close", 0);

    await expect(run).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      "python3",
      ["-m", "clawmodeler_engine", "doctor", "--json"],
      { stdio: "inherit" },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("propagates nonzero sidecar exits", async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const run = runClawModelerEngine(["export", "--workspace", "demo", "--run-id", "bad"]);
    child.emit("close", 40);

    await expect(run).rejects.toThrow("clawmodeler-engine exited with code 40");
    expect(process.exitCode).toBe(40);
  });
});
