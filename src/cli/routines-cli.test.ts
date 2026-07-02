// Routines CLI tests cover durable-routine command parameter construction.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRoutinesCli } from "./routines-cli.js";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    callGatewayFromCli: vi.fn(),
  };
});

const { callGatewayFromCli, defaultRuntime } = mocks;

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      mocks.callGatewayFromCli(method, opts, params, extra as number | undefined),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerRoutinesCli(program);
  return program;
}

function resetGatewayMock() {
  callGatewayFromCli.mockClear();
  callGatewayFromCli.mockImplementation(async (method: string) => {
    if (method === "cron.status") {
      return { enabled: true };
    }
    if (method === "routines.create") {
      return { created: true, routine: { id: "routine-1" } };
    }
    return {};
  });
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.writeStdout.mockClear();
  defaultRuntime.writeJson.mockClear();
  defaultRuntime.exit.mockClear();
}

async function runRoutinesCommand(args: string[]): Promise<void> {
  resetGatewayMock();
  const program = buildProgram();
  await program.parseAsync(args, { from: "user" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registerRoutinesCli", () => {
  it("defaults keyless isolated message routines to no delivery", async () => {
    await runRoutinesCommand([
      "routines",
      "create",
      "every 1h",
      "check status",
      "--name",
      "Default delivery",
    ]);

    const createCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "routines.create");
    const params = createCall?.[2] as {
      target?: { delivery?: { mode?: string; channel?: string } };
    };

    expect(params?.target?.delivery).toMatchObject({
      mode: "none",
    });
  });

  it("rejects relative one-shot schedules across retried invocations", async () => {
    vi.useFakeTimers();
    for (const now of ["2026-07-01T12:00:00Z", "2026-07-01T12:05:00Z"]) {
      vi.setSystemTime(new Date(now));
      await expect(
        runRoutinesCommand([
          "routines",
          "create",
          "--at",
          "+20m",
          "--name",
          "Relative follow-up",
          "--message",
          "check status",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "routines.create")).toBe(
        false,
      );
      expect(defaultRuntime.error.mock.calls[0]?.[0]).toContain(
        "Relative one-shot routine schedules are not idempotent",
      );
    }
  });

  it("rejects positional schedules when a schedule flag is also present", async () => {
    await expect(
      runRoutinesCommand([
        "routines",
        "create",
        "0 9 * * *",
        "--every",
        "1h",
        "--name",
        "Conflicting schedule",
        "--message",
        "check status",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "routines.create")).toBe(
      false,
    );
    expect(defaultRuntime.error.mock.calls[0]?.[0]).toContain(
      "Choose a positional schedule or one of --at, --every, --cron",
    );
  });

  it("defaults session-key message routines to last-channel announce delivery", async () => {
    await runRoutinesCommand([
      "routines",
      "create",
      "every 1h",
      "check status",
      "--name",
      "Default delivery",
      "--session-key",
      "agent:ops:telegram:direct:alice",
    ]);

    const createCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "routines.create");
    const params = createCall?.[2] as {
      owner?: { sessionKey?: string };
      target?: { delivery?: { mode?: string; channel?: string } };
    };

    expect(params?.owner?.sessionKey).toBe("agent:ops:telegram:direct:alice");
    expect(params?.target?.delivery).toMatchObject({
      mode: "announce",
      channel: "last",
    });
  });

  it("uses explicit session targets as stable announce recipients", async () => {
    for (const extraArgs of [[], ["--announce"]]) {
      await runRoutinesCommand([
        "routines",
        "create",
        "every 1h",
        "check status",
        "--name",
        "Session target delivery",
        "--session",
        "session:agent:ops:main",
        ...extraArgs,
      ]);

      const createCall = callGatewayFromCli.mock.calls.find(
        (call) => call[0] === "routines.create",
      );
      const params = createCall?.[2] as {
        target?: { sessionTarget?: string; delivery?: { mode?: string; channel?: string } };
      };

      expect(params?.target?.sessionTarget).toBe("session:agent:ops:main");
      expect(params?.target?.delivery).toMatchObject({
        mode: "announce",
        channel: "last",
      });
    }
  });

  it("leaves keyless explicit destinations for gateway channel validation", async () => {
    await runRoutinesCommand([
      "routines",
      "create",
      "every 1h",
      "check status",
      "--name",
      "Destination delivery",
      "--to",
      "chat-1",
    ]);

    const createCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "routines.create");
    const params = createCall?.[2] as {
      target?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };

    expect(params?.target?.delivery).toMatchObject({
      mode: "announce",
      to: "chat-1",
    });
    expect(params?.target?.delivery?.channel).toBeUndefined();
  });

  it("rejects announce delivery without a stable destination", async () => {
    await expect(
      runRoutinesCommand([
        "routines",
        "create",
        "every 1h",
        "check status",
        "--name",
        "Missing delivery target",
        "--announce",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "routines.create")).toBe(false);
    expect(defaultRuntime.error.mock.calls[0]?.[0]).toContain(
      "Announce delivery requires --to, --session, or --session-key.",
    );
  });

  it("rejects webhook delivery for main system-event routines", async () => {
    await expect(
      runRoutinesCommand([
        "routines",
        "create",
        "every 1h",
        "--name",
        "Main webhook",
        "--system-event",
        "check status",
        "--webhook",
        "https://example.invalid/hook",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "routines.create")).toBe(false);
    expect(defaultRuntime.error.mock.calls[0]?.[0]).toContain(
      "Delivery options require a non-main message routine.",
    );
  });

  it("rejects blank explicit routine ids before calling the Gateway", async () => {
    await expect(
      runRoutinesCommand([
        "routines",
        "create",
        "every 1h",
        "check status",
        "--id",
        "   ",
        "--name",
        "Blank id",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "routines.create")).toBe(false);
    expect(defaultRuntime.error.mock.calls[0]?.[0]).toContain("--id must not be blank");
  });
});
