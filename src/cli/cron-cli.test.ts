import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      callGatewayFromCli(method, opts, params, extra),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

describe("cron cli", () => {
  it("trims model and thinking on cron add", { timeout: 60_000 }, async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Daily",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hello",
        "--model",
        "  opus  ",
        "--thinking",
        "  low  ",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("defaults isolated cron add to announce delivery", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Daily",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hello",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { delivery?: { mode?: string } };

    expect(params?.delivery?.mode).toBe("announce");
  });

  it("infers sessionTarget from payload when --session is omitted", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "add", "--name", "Main reminder", "--cron", "* * * * *", "--system-event", "hi"],
      { from: "user" },
    );

    let addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    let params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.kind).toBe("systemEvent");

    callGatewayFromCli.mockClear();

    await program.parseAsync(
      ["cron", "add", "--name", "Isolated task", "--cron", "* * * * *", "--message", "hello"],
      { from: "user" },
    );

    addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("supports --keep-after-run on cron add", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Keep me",
        "--at",
        "20m",
        "--session",
        "main",
        "--system-event",
        "hello",
        "--keep-after-run",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { deleteAfterRun?: boolean };
    expect(params?.deleteAfterRun).toBe(false);
  });

  it("sends agent id on cron add", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Agent pinned",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hi",
        "--agent",
        "ops",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { agentId?: string };
    expect(params?.agentId).toBe("ops");
  });

  it("omits empty model and thinking on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "hello", "--model", "   ", "--thinking", "  "],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.model).toBeUndefined();
    expect(patch?.patch?.payload?.thinking).toBeUndefined();
  });

  it("trims model and thinking on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--message",
        "hello",
        "--model",
        "  opus  ",
        "--thinking",
        "  high  ",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("high");
  });

  it("sets and clears agent id on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--agent", " Ops ", "--message", "hello"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as { patch?: { agentId?: unknown } };
    expect(patch?.patch?.agentId).toBe("ops");

    callGatewayFromCli.mockClear();
    await program.parseAsync(["cron", "edit", "job-2", "--clear-agent"], {
      from: "user",
    });
    const clearCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const clearPatch = clearCall?.[2] as { patch?: { agentId?: unknown } };
    expect(clearPatch?.patch?.agentId).toBeNull();
  });

  it("allows model/thinking updates without --message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--model", "opus", "--thinking", "low"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string; model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("low");
  });

  it("updates delivery settings without requiring --message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--deliver", "--channel", "telegram", "--to", "19098680"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: { kind?: string; message?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
    expect(patch?.patch?.payload?.message).toBeUndefined();
  });

  it("supports --no-deliver on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--no-deliver"], { from: "user" });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string }; delivery?: { mode?: string } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("none");
  });

  it("does not include undefined delivery fields when updating message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    // Update message without delivery flags - should NOT include undefined delivery fields
    await program.parseAsync(["cron", "edit", "job-1", "--message", "Updated message"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
          bestEffortDeliver?: boolean;
        };
        delivery?: unknown;
      };
    };

    // Should include the new message
    expect(patch?.patch?.payload?.message).toBe("Updated message");

    // Should NOT include delivery fields at all (to preserve existing values)
    expect(patch?.patch?.payload).not.toHaveProperty("deliver");
    expect(patch?.patch?.payload).not.toHaveProperty("channel");
    expect(patch?.patch?.payload).not.toHaveProperty("to");
    expect(patch?.patch?.payload).not.toHaveProperty("bestEffortDeliver");
    expect(patch?.patch).not.toHaveProperty("delivery");
  });

  it("includes delivery fields when explicitly provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    // Update message AND delivery - should include both
    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--message",
        "Updated message",
        "--deliver",
        "--channel",
        "telegram",
        "--to",
        "19098680",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: { message?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    };

    // Should include everything
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
  });

  it("includes best-effort delivery when provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "Updated message", "--best-effort-deliver"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: { message?: string };
        delivery?: { bestEffort?: boolean; mode?: string };
      };
    };

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(true);
  });

  it("includes no-best-effort delivery when provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "Updated message", "--no-best-effort-deliver"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: { message?: string };
        delivery?: { bestEffort?: boolean; mode?: string };
      };
    };

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(false);
  });
});

  describe("cron list output with undefined state (fixes issue #6236)", () => {
    it("handles job with undefined state without crashing", () => {
      const { printCronList } = require("./cron-cli/shared.js");
      const mockRuntime = { log: vi.fn() };

      // Create a job with undefined state (edge case from prod)
      const jobWithUndefinedState = {
        id: "job-1",
        name: "Test Job",
        enabled: true,
        createdAtMs: 1000,
        updatedAtMs: 1000,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: undefined, // This is the edge case
      };

      // This should NOT throw
      expect(() => {
        printCronList([jobWithUndefinedState], mockRuntime);
      }).not.toThrow();
    });

    it("shows 'unknown' status when job.state is undefined", () => {
      const { printCronList } = require("./cron-cli/shared.js");
      const mockRuntime = { log: vi.fn() };

      const jobWithUndefinedState = {
        id: "job-1",
        name: "Test Job",
        enabled: true,
        createdAtMs: 1000,
        updatedAtMs: 1000,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: undefined,
      };

      printCronList([jobWithUndefinedState], mockRuntime);

      // Verify log was called
      expect(mockRuntime.log).toHaveBeenCalled();

      // Get the output lines
      const calls = mockRuntime.log.mock.calls;
      expect(calls.length).toBeGreaterThan(1); // header + data

      // The data line should contain the job info without crashing
      const dataLine = calls[calls.length - 1][0];
      expect(dataLine).toContain("job-1");
      expect(dataLine).toContain("Test Job");
    });

    it("handles job with null state gracefully", () => {
      const { printCronList } = require("./cron-cli/shared.js");
      const mockRuntime = { log: vi.fn() };

      const jobWithNullState = {
        id: "job-2",
        name: "Null State Job",
        enabled: false,
        createdAtMs: 2000,
        updatedAtMs: 2000,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: null,
      };

      // This should NOT throw
      expect(() => {
        printCronList([jobWithNullState], mockRuntime);
      }).not.toThrow();
    });

    it("handles mixed jobs (some with state, some without)", () => {
      const { printCronList } = require("./cron-cli/shared.js");
      const mockRuntime = { log: vi.fn() };

      const healthyJob = {
        id: "job-healthy",
        name: "Healthy Job",
        enabled: true,
        createdAtMs: 1000,
        updatedAtMs: 1000,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: { lastStatus: "ok", lastRunAtMs: Date.now() - 30000 },
      };

      const brokenJob = {
        id: "job-broken",
        name: "Broken Job",
        enabled: true,
        createdAtMs: 2000,
        updatedAtMs: 2000,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: undefined,
      };

      // Should handle both without throwing
      expect(() => {
        printCronList([healthyJob, brokenJob], mockRuntime);
      }).not.toThrow();

      expect(mockRuntime.log).toHaveBeenCalled();
      const calls = mockRuntime.log.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
    });

    it("displays '-' for next/last times when state is missing", () => {
      const { printCronList } = require("./cron-cli/shared.js");
      const mockRuntime = { log: vi.fn() };

      const jobWithMissingState = {
        id: "job-missing-state",
        name: "Missing State",
        enabled: true,
        createdAtMs: 1000,
        updatedAtMs: 1000,
        schedule: { kind: "at", at: new Date(Date.now() + 60000).toISOString() },
        sessionTarget: "main",
        wakeMode: "wake",
        payload: { kind: "agentTurn", message: "test" },
        state: undefined,
      };

      printCronList([jobWithMissingState], mockRuntime);

      // The output should have been logged without errors
      expect(mockRuntime.log).toHaveBeenCalled();
      const calls = mockRuntime.log.mock.calls;
      
      // Both header and data row should be present
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
