import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { resolveSshClient } from "./ssh-client.js";
import { resolveSshConfig } from "./ssh-config.js";

// mock-isolation: Parse fixed SSH output without launching host processes.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));
// mock-isolation: Keep the SSH binary deterministic instead of probing the host PATH.
vi.mock("./ssh-client.js", () => ({ resolveSshClient: vi.fn(() => "/usr/bin/ssh") }));

const runCommandMock = vi.mocked(runCommandWithTimeout);
const resolveSshClientMock = vi.mocked(resolveSshClient);
const ssh = "/usr/bin/ssh";
const host = "peters-mac-studio-1.sheep-coho.ts.net";
const sshOutput = `user steipete\nhostname ${host}\nport 2222\nidentityfile none\nidentityfile /tmp/id_ed25519\n`;
const target = { user: "me", host: "alias", port: 22 };
const command = () => runCommandMock.mock.calls[0]?.[0];

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof runCommandWithTimeout>>> = {},
): Awaited<ReturnType<typeof runCommandWithTimeout>> {
  return createCommandResult({ stdout: sshOutput, ...overrides });
}

describe("ssh-config", () => {
  beforeEach(() => {
    runCommandMock.mockReset().mockResolvedValue(commandResult());
    resolveSshClientMock.mockReset().mockReturnValue(ssh);
  });

  it.each([
    [
      "alias:22",
      "user me\nhostname resolved.example\nport 22\n",
      ["-p", "22"],
      { user: "me", host: "resolved.example", port: 22, identityFiles: [] },
    ],
    [
      "alias",
      sshOutput,
      [],
      { user: "steipete", host, port: 2222, identityFiles: ["/tmp/id_ed25519"] },
    ],
  ] as const)(
    "resolves explicit or inherited port for %s",
    async (input, stdout, portArgs, resolvedTarget) => {
      runCommandMock.mockResolvedValueOnce(commandResult({ stdout }));
      await expect(
        resolveSshConfig({ host: "alias", port: 22 }, { explicitPort: input === "alias:22" }),
      ).resolves.toEqual(resolvedTarget);
      expect(command()).toEqual([ssh, "-G", ...portArgs, "--", "alias"]);
    },
  );

  it("ignores invalid ports and blank lines", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({
        stdout:
          "user bob\nhostname example.com\nport not-a-number\nidentityfile none\nidentityfile   \n",
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
      resolveSshConfig({ ...target, port: 2022 }, { identity: "  /tmp/custom_id  " }),
    ).resolves.toEqual({
      user: "steipete",
      host,
      port: 2222,
      identityFiles: ["/tmp/id_ed25519"],
    });
    expect(command()).toEqual([ssh, "-G", "-p", "2022", "-i", "/tmp/custom_id", "--", "me@alias"]);
    expect(runCommandMock.mock.calls[0]?.[1]).toMatchObject({
      maxOutputBytes: 64 * 1024,
      outputCapture: "head",
      terminateOnOutputLimit: true,
    });
    expect(resolveSshClientMock).toHaveBeenCalledOnce();
  });

  it.each(["empty output", "launch failure"])("returns null on %s", async (failure) => {
    if (failure === "launch failure") {
      runCommandMock.mockRejectedValueOnce(new Error("spawn boom"));
    } else {
      runCommandMock.mockResolvedValueOnce(commandResult({ stdout: "" }));
    }
    await expect(resolveSshConfig(target)).resolves.toBeNull();
  });

  it("returns null without launching when no trusted SSH client is installed", async () => {
    resolveSshClientMock.mockReturnValueOnce(null);

    await expect(resolveSshConfig(target)).resolves.toBeNull();
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
