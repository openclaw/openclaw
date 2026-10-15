// ACP CLI option collision tests cover ACP command flag registration boundaries.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { withTempSecretFiles } from "../test-utils/secret-file-fixture.js";
import { registerAcpCli } from "./acp-cli.js";

type AcpClientOptions = {
  verbose?: boolean;
};

type AcpGatewayOptions = {
  gatewayPassword?: string;
  gatewayToken?: string;
  prefixCwd?: boolean;
};

const mocks = vi.hoisted(() => ({
  runAcpClientInteractive: vi.fn(async (_opts: AcpClientOptions) => 0),
  serveAcpGateway: vi.fn(async (_opts: AcpGatewayOptions) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { runAcpClientInteractive, serveAcpGateway, defaultRuntime } = mocks;

vi.mock("../acp/client.js", () => ({
  runAcpClientInteractive: (opts: AcpClientOptions) => mocks.runAcpClientInteractive(opts),
}));

vi.mock("../acp/server.js", () => ({
  serveAcpGateway: (opts: AcpGatewayOptions) => mocks.serveAcpGateway(opts),
}));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return { ...actual, defaultRuntime: mocks.defaultRuntime };
});

describe("acp cli option collisions", () => {
  function createAcpProgram() {
    const program = new Command();
    registerAcpCli(program);
    return program;
  }

  async function parseAcp(args: string[]) {
    const program = createAcpProgram();
    await program.parseAsync(["acp", ...args], { from: "user" });
  }

  function expectCliError(pattern: RegExp) {
    expect(serveAcpGateway).not.toHaveBeenCalled();
    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors.some((message) => pattern.test(message))).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  }

  beforeEach(() => {
    runAcpClientInteractive.mockClear();
    serveAcpGateway.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockReset();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    await runRegisteredCli({
      register: registerAcpCli as (program: Command) => void,
      argv: ["acp", "client", "--verbose"],
    });

    expect(runAcpClientInteractive).toHaveBeenCalledTimes(1);
    const clientOptions = mockCall(runAcpClientInteractive)[0] as { verbose?: boolean };
    expect(clientOptions?.verbose).toBe(true);
  });

  it.each([0, 7, 130])(
    "preserves client exit code %i without logging it as failure",
    async (code) => {
      runAcpClientInteractive.mockResolvedValueOnce(code);
      defaultRuntime.exit.mockImplementation((exitCode: number) => {
        throw new ExitError(exitCode);
      });

      const command = parseAcp(["client"]);
      if (code === 0) {
        await expect(command).resolves.toBeUndefined();
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } else {
        await expect(command).rejects.toEqual(new ExitError(code));
        expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(code);
      }
      expect(defaultRuntime.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "rejects mixed password flags and file flags",
      files: { password: "pw_file\n" }, // pragma: allowlist secret
      args: (_tokenFile: string, passwordFile: string) => [
        "--password",
        "pw_inline",
        "--password-file",
        passwordFile,
      ],
      expected: /Use either --passw.*d .*--password-file for Gateway password\./,
    },
  ])("$name", async ({ files, args, expected }) => {
    await withTempSecretFiles("openclaw-acp-cli-", files, async ({ tokenFile, passwordFile }) => {
      await parseAcp(args(tokenFile ?? "", passwordFile ?? ""));
    });

    expectCliError(expected);
  });

  it("warns when inline secret flags are used", async () => {
    await parseAcp(["--token", "tok_inline", "--password", "pw_inline"]);

    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors).toContain(
      "Warning: --token can be exposed via process listings. Prefer --token-file or environment variables.",
    );
    expect(errors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or environment variables.",
    );
  });

  it("trims token file path before reading", async () => {
    await withTempSecretFiles("openclaw-acp-cli-", { token: "tok_file\n" }, async (files) => {
      await parseAcp(["--token-file", `  ${files.tokenFile ?? ""}  `]);
    });

    expect(serveAcpGateway).toHaveBeenCalledTimes(1);
    const gatewayOptions = mockCall(serveAcpGateway)[0] as { gatewayToken?: string };
    expect(gatewayOptions?.gatewayToken).toBe("tok_file");
  });

  it("formats client errors with formatErrorMessage instead of String(err) (#83904)", async () => {
    runAcpClientInteractive.mockImplementationOnce(async () => {
      throw { code: 42, why: "boom" } as unknown as Error;
    });
    const program = createAcpProgram();
    await program.parseAsync(["acp", "client"], { from: "user" });

    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors).toContain('{"code":42,"why":"boom"}');
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
