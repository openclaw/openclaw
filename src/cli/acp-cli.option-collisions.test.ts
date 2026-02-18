import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAcpClientInteractive = vi.fn(async (_opts: unknown) => {});
const serveAcpGateway = vi.fn(async (_opts: unknown) => {});

const defaultRuntime = {
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../acp/client.js", () => ({
  runAcpClientInteractive: (opts: unknown) => runAcpClientInteractive(opts),
}));

vi.mock("../acp/server.js", () => ({
  serveAcpGateway: (opts: unknown) => serveAcpGateway(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

describe("acp cli option collisions", () => {
  beforeEach(() => {
    runAcpClientInteractive.mockClear();
    serveAcpGateway.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    const { registerAcpCli } = await import("./acp-cli.js");
    const program = new Command();
    registerAcpCli(program);

    await program.parseAsync(["acp", "client", "--verbose"], { from: "user" });

    expect(runAcpClientInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        verbose: true,
      }),
    );
  });
});
