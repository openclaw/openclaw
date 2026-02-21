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

  async function withSecretFiles<T>(
    secrets: { token?: string; password?: string },
    run: (files: { tokenFile?: string; passwordFile?: string }) => Promise<T>,
  ): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-cli-"));
    try {
      const files: { tokenFile?: string; passwordFile?: string } = {};
      if (secrets.token !== undefined) {
        files.tokenFile = path.join(dir, "token.txt");
        await fs.writeFile(files.tokenFile, secrets.token, "utf8");
      }
      if (secrets.password !== undefined) {
        files.passwordFile = path.join(dir, "password.txt");
        await fs.writeFile(files.passwordFile, secrets.password, "utf8");
      }
      return await run(files);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

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

    await withSecretFiles({ token: "tok_file\n", password: "pw_file\n" }, async (files) => {
      await program.parseAsync(
        ["acp", "--token-file", files.tokenFile ?? "", "--password-file", files.passwordFile ?? ""],
        {
          from: "user",
        },
      );
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

    await withSecretFiles({ token: "tok_file\n" }, async (files) => {
      await program.parseAsync(
        ["acp", "--token", "tok_inline", "--token-file", files.tokenFile ?? ""],
        {
          from: "user",
        },
      );
    });

    expect(serveAcpGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(/Use either --token or --token-file/),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects mixed password flags and file flags", async () => {
    const { registerAcpCli } = await import("./acp-cli.js");
    const program = new Command();
    registerAcpCli(program);

    await withSecretFiles({ password: "pw_file\n" }, async (files) => {
      await program.parseAsync(
        ["acp", "--password", "pw_inline", "--password-file", files.passwordFile ?? ""],
        {
          from: "user",
        },
      );
    });

    expect(serveAcpGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(/Use either --password or --password-file/),
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
