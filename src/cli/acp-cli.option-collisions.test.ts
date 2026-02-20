import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

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
  let registerAcpCli: typeof import("./acp-cli.js").registerAcpCli;

  beforeAll(async () => {
    ({ registerAcpCli } = await import("./acp-cli.js"));
  });

  beforeEach(() => {
    runAcpClientInteractive.mockClear();
    serveAcpGateway.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    await runRegisteredCli({
      register: registerAcpCli as (program: Command) => void,
      argv: ["acp", "client", "--verbose"],
    });

    expect(runAcpClientInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        verbose: true,
      }),
    );
  });

  it("loads gateway token/password from files", async () => {
    const { registerAcpCli } = await import("./acp-cli.js");
    const program = new Command();
    registerAcpCli(program);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-cli-"));
    const tokenFile = path.join(dir, "token.txt");
    const passwordFile = path.join(dir, "password.txt");
    await fs.writeFile(tokenFile, "tok_file\n", "utf8");
    await fs.writeFile(passwordFile, "pw_file\n", "utf8");

    await program.parseAsync(["acp", "--token-file", tokenFile, "--password-file", passwordFile], {
      from: "user",
    });

    expect(serveAcpGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayToken: "tok_file",
        gatewayPassword: "pw_file",
      }),
    );
  });

  it("rejects mixed secret flags and file flags", async () => {
    const { registerAcpCli } = await import("./acp-cli.js");
    const program = new Command();
    registerAcpCli(program);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-cli-"));
    const tokenFile = path.join(dir, "token.txt");
    await fs.writeFile(tokenFile, "tok_file\n", "utf8");

    await program.parseAsync(["acp", "--token", "tok_inline", "--token-file", tokenFile], {
      from: "user",
    });

    expect(serveAcpGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(/Use either --token or --token-file/),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("warns when inline secret flags are used", async () => {
    const { registerAcpCli } = await import("./acp-cli.js");
    const program = new Command();
    registerAcpCli(program);

    await program.parseAsync(["acp", "--token", "tok_inline", "--password", "pw_inline"], {
      from: "user",
    });

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(/--token can be exposed via process listings/),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(/--password can be exposed via process listings/),
    );
  });
});
