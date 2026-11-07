import { execFile } from "node:child_process";
import { once } from "node:events";
import { readlinkSync } from "node:fs";
import net from "node:net";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux")("mock OpenAI bind diagnostics", () => {
  it.each([false, true])("preserves bind failure with diagnostics=%s", async (enabled) => {
    // Keep the listener bound: there is no free-port probe/release race.
    const owner = net.createServer();
    owner.listen(0, "127.0.0.1");
    await once(owner, "listening");
    let client: net.Socket | undefined;
    try {
      const address = owner.address();
      if (!address || typeof address === "string") {
        throw new Error("missing fixture listener");
      }
      client = net.createConnection(address.port, "127.0.0.1");
      await once(client, "connect");
      const result = await new Promise<{
        code: string | number | undefined;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          ["scripts/e2e/mock-openai-server.mjs", "PRIVATE_ARG_SENTINEL"],
          {
            env: {
              ...process.env,
              MOCK_PORT: String(address.port),
              OPENCLAW_MOCK_LISTEN_DIAGNOSTIC_LAUNCH: enabled ? "1" : "",
              PRIVATE_ENV_SENTINEL: "DO_NOT_CAPTURE",
            },
            timeout: 10_000,
            maxBuffer: 128 * 1024,
          },
          (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }),
        );
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("EADDRINUSE");
      expect(result.stdout).not.toContain("mock-openai listening");
      expect(result.stderr).not.toMatch(/PRIVATE_ARG_SENTINEL|PRIVATE_ENV_SENTINEL|DO_NOT_CAPTURE/);
      const snapshots = result.stderr
        .split("\n")
        .filter((line) => line.startsWith('{"event":"mock-openai-bind-diagnostic"'))
        .map((line) => JSON.parse(line));
      expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(
        enabled ? ["before-listen", "EADDRINUSE"] : [],
      );
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({
          launchCount: 1,
          port: address.port,
          networkNamespace: readlinkSync("/proc/self/ns/net"),
          truncated: false,
        });
        expect(snapshot.mockPid).toEqual(expect.any(Number));
        expect(snapshot.sockets).toContainEqual({
          family: "tcp",
          state: "0A",
          localPort: address.port,
          remotePort: 0,
          inode: expect.stringMatching(/^[1-9][0-9]*$/),
          owners: [{ pid: process.pid, basename: basename(readlinkSync("/proc/self/exe")) }],
        });
        expect(snapshot.sockets).toContainEqual({
          family: "tcp",
          state: "01",
          localPort: client.localPort,
          remotePort: address.port,
          inode: expect.stringMatching(/^[1-9][0-9]*$/),
          owners: [{ pid: process.pid, basename: basename(readlinkSync("/proc/self/exe")) }],
        });
        expect(Object.keys(snapshot).toSorted()).toEqual(
          [
            "event",
            "launchCount",
            "mockPid",
            "networkNamespace",
            "phase",
            "port",
            "sockets",
            "truncated",
            "unavailable",
          ].toSorted(),
        );
      }
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => {
        owner.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
