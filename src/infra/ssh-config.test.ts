// Tests SSH config parsing and canonical command execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSshTarget } from "../commands/gateway-status/discovery.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveSshClient } from "./ssh-client.js";
import { resolveSshConfig } from "./ssh-config.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("./ssh-client.js", () => ({
  resolveSshClient: vi.fn(() => "/usr/bin/ssh"),
}));

const runCommandMock = vi.mocked(runCommandWithTimeout);
const resolveSshClientMock = vi.mocked(resolveSshClient);
const sshOutput = [
  "user steipete",
  "hostname peters-mac-studio-1.sheep-coho.ts.net",
  "port 2222",
  "identityfile none",
  "identityfile /tmp/id_ed25519",
  "",
].join("\n");

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof runCommandWithTimeout>>> = {},
): Awaited<ReturnType<typeof runCommandWithTimeout>> {
  return {
    stdout: sshOutput,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("ssh-config", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue(commandResult());
    resolveSshClientMock.mockReset();
    resolveSshClientMock.mockReturnValue("/usr/bin/ssh");
  });

  it("preserves an explicit default port through probe target resolution", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({ stdout: "user me\nhostname resolved.example\nport 22\n" }),
    );
    const resolved = await resolveSshTarget({
      rawTarget: "alias:22",
      identity: null,
      overallTimeoutMs: 1000,
    });
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual([
      "/usr/bin/ssh",
      "-G",
      "-p",
      "22",
      "--",
      "alias",
    ]);
    expect(resolved?.target).toBe("me@resolved.example:22");
  });

  it("inherits the alias port when the probe target omits a port", async () => {
    const resolved = await resolveSshTarget({
      rawTarget: "alias",
      identity: null,
      overallTimeoutMs: 1000,
    });
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual(["/usr/bin/ssh", "-G", "--", "alias"]);
    expect(resolved?.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
  });

  it.each(["not-a-number"])("ignores invalid port %s and blank lines", async (port) => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({
        stdout: `user bob\nhostname example.com\nport ${port}\nidentityfile none\nidentityfile   \n`,
      }),
    );
    await expect(resolveSshConfig({ host: "alias", port: 22 })).resolves.toEqual({
      user: "bob",
      host: "example.com",
      port: undefined,
      identityFiles: [],
    });
  });

  it("adds non-default port and trimmed identity arguments", async () => {
    await expect(
      resolveSshConfig(
        { user: "me", host: "alias", port: 2022 },
        { identity: "  /tmp/custom_id  " },
      ),
    ).resolves.toEqual({
      user: "steipete",
      host: "peters-mac-studio-1.sheep-coho.ts.net",
      port: 2222,
      identityFiles: ["/tmp/id_ed25519"],
    });
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual([
      "/usr/bin/ssh",
      "-G",
      "-p",
      "2022",
      "-i",
      "/tmp/custom_id",
      "--",
      "me@alias",
    ]);
    expect(runCommandMock.mock.calls[0]?.[1]).toMatchObject({
      maxOutputBytes: 64 * 1024,
      outputCapture: "head",
      terminateOnOutputLimit: true,
    });
    expect(resolveSshClientMock).toHaveBeenCalledOnce();
  });

  it.each([commandResult({ stdout: "" })])(
    "returns null for an unusable command result",
    async (result) => {
      runCommandMock.mockResolvedValueOnce(result);
      await expect(
        resolveSshConfig({ user: "me", host: "bad-host", port: 22 }),
      ).resolves.toBeNull();
    },
  );

  it("returns null when command launch fails", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("spawn boom"));
    await expect(resolveSshConfig({ user: "me", host: "bad-host", port: 22 })).resolves.toBeNull();
  });

  it("returns null without launching when no trusted SSH client is installed", async () => {
    resolveSshClientMock.mockReturnValueOnce(null);

    await expect(resolveSshConfig({ user: "me", host: "alias", port: 22 })).resolves.toBeNull();
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
