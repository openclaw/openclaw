import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("workqueue-worker cli", () => {
  it("supports --dry-run (claims item but does not execute)", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((cmd: string, args: string[], _opts: any, cb: any) => {
      const joined = args.join(" ");
      if (joined.includes("workqueue claim-next")) {
        cb(null, {
          stdout: JSON.stringify({
            ok: true,
            item: {
              id: "item-1",
              queue: "dev-team",
              title: "Test",
              instructions: "Do the thing",
            },
          }),
          stderr: "",
        });
        return;
      }
      cb(new Error(`unexpected execFile call: ${cmd} ${joined}`));
    });

    const program = new Command();
    const { registerWorkqueueWorkerCli } = await import("./workqueue-worker-cli.js");
    registerWorkqueueWorkerCli(program);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    await program.parseAsync([
      "node",
      "openclaw",
      "workqueue-worker",
      "--agent",
      "dev",
      "--queues",
      "dev-team",
      "--dry-run",
      "--json",
      "--clawnsole",
      "clawnsole",
      "--openclaw",
      "openclaw",
    ]);

    logSpy.mockRestore();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const out = logs.join("\n");
    expect(out).toContain('"action": "dry_run"');
    expect(out).toContain('"id": "item-1"');
  });

  it("prints noop_empty when claim-next returns null item", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((cmd: string, args: string[], _opts: any, cb: any) => {
      const joined = args.join(" ");
      if (joined.includes("workqueue claim-next")) {
        cb(null, { stdout: JSON.stringify({ ok: true, item: null }), stderr: "" });
        return;
      }
      cb(new Error(`unexpected execFile call: ${cmd} ${joined}`));
    });

    const program = new Command();
    const { registerWorkqueueWorkerCli } = await import("./workqueue-worker-cli.js");
    registerWorkqueueWorkerCli(program);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    await program.parseAsync([
      "node",
      "openclaw",
      "workqueue-worker",
      "--agent",
      "dev",
      "--queues",
      "dev-team",
      "--json",
      "--idleMs",
      "0",
      "--clawnsole",
      "clawnsole",
      "--openclaw",
      "openclaw",
    ]);

    logSpy.mockRestore();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain('"action": "noop_empty"');
  });
});
