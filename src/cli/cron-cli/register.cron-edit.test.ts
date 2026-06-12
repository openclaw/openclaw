// Cron edit register tests cover cron edit command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createCronProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronEditCommand(program);
  return program;
}

describe("cron edit command", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("documents that --best-effort-deliver implies announce mode when used alone (#83908)", () => {
    const editCommand = createCronProgram().commands.find((command) => command.name() === "edit");
    const help = editCommand?.helpInformation() ?? "";

    expect(help).toContain("--best-effort-deliver");
    expect(help).toMatch(/also\s+implies --announce when used alone/);
  });

  it("keeps --best-effort-deliver-only edits delivery-only (#83908)", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--best-effort-deliver"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ bestEffortDeliver: true }),
      {
        id: "job-1",
        patch: {
          delivery: {
            mode: "announce",
            bestEffort: true,
          },
        },
      },
    );
  });

  it("keeps --no-best-effort-deliver-only edits delivery-only", async () => {
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--no-best-effort-deliver"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ bestEffortDeliver: false }),
      {
        id: "job-1",
        patch: {
          delivery: {
            bestEffort: false,
          },
        },
      },
    );
  });

  it("preserves timezone without copying stale stagger when --cron replaces expression (#92291)", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          schedule: {
            kind: "cron",
            expr: "0 * * * *",
            tz: "America/Phoenix",
            staggerMs: 120_000,
          },
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--cron", "0 5 * * *"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), { id: "job-1" });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "America/Phoenix",
          staggerMs: undefined,
        },
      },
    });
  });

  it("allows --tz override when --cron replaces expression (#92291)", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      ["edit", "job-1", "--cron", "0 5 * * *", "--tz", "UTC", "--stagger", "10s"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "UTC",
          staggerMs: 10000,
        },
      },
    });
    expect(callGatewayFromCli).not.toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: expect.any(Number),
      offset: expect.any(Number),
    });
  });

  it("preserves timezone when --cron edits stagger metadata (#92291)", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        return {
          id: "job-1",
          schedule: {
            kind: "cron",
            expr: "0 * * * *",
            tz: "America/Phoenix",
            staggerMs: 120_000,
          },
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--cron", "0 5 * * *", "--stagger", "10s"], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: {
        schedule: {
          kind: "cron",
          expr: "0 5 * * *",
          tz: "America/Phoenix",
          staggerMs: 10000,
        },
      },
    });
  });

  it("preserves command payload kind for timeout-only edits", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
            },
          ],
        };
      }
      return { ok: true };
    });
    const program = createCronProgram();

    await program.parseAsync(["edit", "job-1", "--timeout-seconds", "12"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ timeoutSeconds: "12" }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "command",
            timeoutSeconds: 12,
          },
        },
      },
    );
  });
});
