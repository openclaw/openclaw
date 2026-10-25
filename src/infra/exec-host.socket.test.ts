import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requestExecHostViaSocket, type ExecHostRequest } from "./exec-host.js";

const token = "exec-host-socket-test-token";
const success = {
  ok: true,
  payload: { exitCode: 0, timedOut: false, success: true, stdout: "done\n", stderr: "" },
};
const denial = {
  ok: false,
  error: { code: "UNAVAILABLE", message: "Denied by host policy", reason: "security=deny" },
};
const request: ExecHostRequest = {
  command: ["/bin/echo", "done"],
  cwd: "/tmp",
  needsScreenRecording: false,
};

// This peer proves the TypeScript transport, not Swift policy or native execution.
async function withExecPeer(response: typeof success | typeof denial) {
  await withTestDir({ prefix: "oc-exec-", parentDir: "/tmp" }, async (dir) => {
    const socketPath = path.join(dir, "host.sock");
    const order: string[] = [];
    const sockets: net.Socket[] = [];
    const tasks: Promise<void>[] = [];
    const failures: unknown[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.push(socket);
      socket.on("error", (error) => failures.push(error));
      let wire = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        wire += chunk;
      });
      const task = (async () => {
        await once(socket, "end");
        order.push("request-half-closed");
        expect(wire.endsWith("\n")).toBe(true);
        expect(wire.trim().split("\n")).toHaveLength(1);
        const envelope = JSON.parse(wire) as {
          type: string;
          id: string;
          nonce: string;
          ts: number;
          hmac: string;
          requestJson: string;
        };
        expect(envelope).toEqual({
          type: "exec",
          id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          ts: expect.any(Number),
          hmac: expect.any(String),
          requestJson: expect.any(String),
        });
        expect(Math.abs(Date.now() - envelope.ts)).toBeLessThan(10_000);
        const hmac = crypto
          .createHmac("sha256", token)
          .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
          .digest("hex");
        expect(envelope.hmac).toBe(hmac);
        expect(JSON.parse(envelope.requestJson)).toEqual(request);
        // Write EOF must not become response EOF.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        order.push("response");
        socket.end(`${JSON.stringify({ type: "exec-res", id: envelope.id, ...response })}\n`);
      })().catch((error: unknown) => {
        failures.push(error);
        socket.destroy();
      });
      tasks.push(task);
    });
    try {
      const listening = once(server, "listening");
      server.listen(socketPath);
      await listening;
      await expect(
        requestExecHostViaSocket({ socketPath, token, request, timeoutMs: 1_000 }),
      ).resolves.toEqual(response);
      expect(order).toEqual(["request-half-closed", "response"]);
      await Promise.all(tasks);
      expect(failures).toEqual([]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

describe.runIf(process.platform !== "win32")("exec host real UDS boundary", () => {
  it("characterizes a missing socket before any request can execute", () =>
    withTestDir({ prefix: "oc-exec-", parentDir: "/tmp" }, async (dir) => {
      const marker = path.join(dir, "never-started");
      await expect(
        requestExecHostViaSocket({
          socketPath: path.join(dir, "missing.sock"),
          token,
          request: { command: ["/usr/bin/touch", marker] },
          timeoutMs: 1_000,
        }),
      ).resolves.toBeNull();
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    }));

  it.each([success, denial])(
    "receives a complete response after request half-close: $ok",
    withExecPeer,
  );
});
