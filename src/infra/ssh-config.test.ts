import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding?: (enc: string) => void };
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stdout = new EventEmitter() as MockSpawnChild["stdout"];
  stdout!.setEncoding = vi.fn();
  child.stdout = stdout;
  child.kill = vi.fn();
  return { child, stdout };
}

vi.mock("node:child_process", () => {
  const spawn = vi.fn(() => {
    const { child, stdout } = createMockSpawnChild();
    process.nextTick(() => {
      stdout?.emit(
        "data",
        [
          "user steipete",
          "hostname peters-mac-studio-1.sheep-coho.ts.net",
          "port 2222",
          "identityfile none",
          "identityfile /tmp/id_ed25519",
          "",
        ].join("\n"),
      );
      child.emit("exit", 0);
    });
    return child;
  });
  return { spawn };
});

const spawnMock = vi.mocked(spawn);

describe("ssh-config", () => {
  it("parses ssh -G output", async () => {
    const { parseSshConfigOutput } = await import("./ssh-config.js");
    const parsed = parseSshConfigOutput(
      "user bob\nhostname example.com\nport 2222\nidentityfile none\nidentityfile /tmp/id\n",
    );
    expect(parsed.user).toBe("bob");
    expect(parsed.host).toBe("example.com");
    expect(parsed.port).toBe(2222);
    expect(parsed.identityFiles).toEqual(["/tmp/id"]);
  });

  it("resolves ssh config via ssh -G", async () => {
    const { resolveSshConfig } = await import("./ssh-config.js");
    const config = await resolveSshConfig({ user: "me", host: "alias", port: 22 });
    expect(config?.user).toBe("steipete");
    expect(config?.host).toBe("peters-mac-studio-1.sheep-coho.ts.net");
    expect(config?.port).toBe(2222);
    expect(config?.identityFiles).toEqual(["/tmp/id_ed25519"]);
    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args?.slice(-2)).toEqual(["--", "me@alias"]);
  });

  it("returns null when ssh -G fails", async () => {
    spawnMock.mockImplementationOnce(() => {
      const { child } = createMockSpawnChild();
      process.nextTick(() => {
        child.emit("exit", 1);
      });
      return child;
    });

    const { resolveSshConfig } = await import("./ssh-config.js");
    const config = await resolveSshConfig({ user: "me", host: "bad-host", port: 22 });
    expect(config).toBeNull();
  });
});
