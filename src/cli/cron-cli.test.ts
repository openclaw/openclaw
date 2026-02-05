import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";

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

describe("printCronList", () => {
  it("handles legacy jobs with atMs instead of at in schedule", async () => {
    const { printCronList } = await import("./cron-cli/shared.js");
    const { defaultRuntime } = await import("../runtime.js");

    // Mock a job with legacy atMs format (as reported in issue #9649)
    const legacyJob = {
      id: "9a867b4d-3aee-4682-9078-3a84e228c804",
      agentId: "main",
      name: "Recordatorio: revisar pago",
      enabled: true,
      createdAtMs: 1770300537733,
      updatedAtMs: 1770300537733,
      // This is the legacy format: atMs instead of at
      schedule: { kind: "at", atMs: 1770307680000 } as unknown as CronJob["schedule"],
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Reminder text" },
      state: { nextRunAtMs: 1770307680000 },
    } as CronJob;

    // This should NOT throw an error
    expect(() => printCronList([legacyJob], defaultRuntime)).not.toThrow();
  });

  it("handles jobs with undefined at in at-type schedule", async () => {
    const { printCronList } = await import("./cron-cli/shared.js");
    const { defaultRuntime } = await import("../runtime.js");

    // Mock a job with kind: "at" but missing the at field entirely
    const malformedJob = {
      id: "test-job-id",
      name: "Test Job",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at" } as unknown as CronJob["schedule"],
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Test" },
      state: {},
    } as CronJob;

    // This should NOT throw an error
    expect(() => printCronList([malformedJob], defaultRuntime)).not.toThrow();
  });
});
