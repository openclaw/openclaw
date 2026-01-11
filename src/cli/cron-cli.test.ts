import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(
  async (method: string, _opts: unknown, params?: unknown) => {
    if (method === "cron.status") return { enabled: true };
    return { ok: true, params };
  },
);

vi.mock("./gateway-rpc.js", async () => {
  const actual =
    await vi.importActual<typeof import("./gateway-rpc.js")>(
      "./gateway-rpc.js",
    );
  return {
    ...actual,
    callGatewayFromCli: (
      method: string,
      opts: unknown,
      params?: unknown,
      extra?: unknown,
    ) => callGatewayFromCli(method, opts, params, extra),
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
  it("trims model and thinking on cron add", async () => {
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

    const addCall = callGatewayFromCli.mock.calls.find(
      (call) => call[0] === "cron.add",
    );
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("omits empty model and thinking on cron edit", async () => {
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
        "   ",
        "--thinking",
        "  ",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find(
      (call) => call[0] === "cron.update",
    );
    const patch = updateCall?.[2] as {
      patch?: { payload?: { model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.model).toBeUndefined();
    expect(patch?.patch?.payload?.thinking).toBeUndefined();
  });
});
