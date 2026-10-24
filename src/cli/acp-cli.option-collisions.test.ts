import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";
import { withTempSecretFiles } from "../test-utils/secret-file-fixture.js";
import { registerAcpCli } from "./acp-cli.js";

type AcpClientOptions = { verbose?: boolean };
type AcpGatewayOptions = { gatewayPassword?: string; gatewayToken?: string; prefixCwd?: boolean };

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
const errors = () => defaultRuntime.error.mock.calls.map(([message]) => String(message));

// mock-isolation: Parse client options without starting an interactive terminal session.
vi.mock("../acp/client.js", () => ({ runAcpClientInteractive: mocks.runAcpClientInteractive }));
// mock-isolation: Parse gateway options without starting the ACP transport.
vi.mock("../acp/server.js", () => ({ serveAcpGateway: mocks.serveAcpGateway }));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return { ...actual, defaultRuntime: mocks.defaultRuntime };
});

describe("acp cli option collisions", () => {
  async function parseAcp(args: string[]) {
    const program = new Command();
    registerAcpCli(program);
    await program.parseAsync(["acp", ...args], { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    defaultRuntime.exit.mockReset();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    await parseAcp(["client", "--verbose"]);

    expect(runAcpClientInteractive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ verbose: true }),
    );
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

  it("rejects mixed password flags and file flags", async () => {
    await withTempSecretFiles("openclaw-acp-cli-", { password: "pw_file\n" }, async (files) => {
      // pragma: allowlist secret
      await parseAcp(["--password", "pw_inline", "--password-file", files.passwordFile ?? ""]);
    });
    expect(serveAcpGateway).not.toHaveBeenCalled();
    expect(errors().join("\n")).toMatch(
      /Use either --passw.*d .*--password-file for Gateway password\./,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("warns when inline secret flags are used", async () => {
    await parseAcp(["--token", "tok_inline", "--password", "pw_inline"]);

    for (const flag of ["token", "password"]) {
      expect(errors()).toContain(
        `Warning: --${flag} can be exposed via process listings. Prefer --${flag}-file or environment variables.`,
      );
    }
  });

  it("trims token file path before reading", async () => {
    await withTempSecretFiles("openclaw-acp-cli-", { token: "tok_file\n" }, async (files) => {
      await parseAcp(["--token-file", `  ${files.tokenFile ?? ""}  `]);
    });

    expect(serveAcpGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ gatewayToken: "tok_file" }),
    );
  });

  it("formats client errors with formatErrorMessage instead of String(err) (#83904)", async () => {
    runAcpClientInteractive.mockRejectedValueOnce({ code: 42, why: "boom" });
    await parseAcp(["client"]);

    expect(errors()).toContain('{"code":42,"why":"boom"}');
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
