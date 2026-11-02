import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import timers from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

// This peer proves the TypeScript transport, not Swift policy or native execution.
async function withExecPeer(
  run: (peer: {
    dir: string;
    socketPath: string;
    markers: string;
    order: string[];
    children: { child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }[];
    onRequest: (
      handler: (socket: net.Socket, request: ExecHostRequest, id: string) => Promise<void>,
    ) => void;
  }) => Promise<void>,
) {
  await withTestDir({ prefix: "oc-exec-", parentDir: "/tmp" }, async (dir) => {
    const socketPath = path.join(dir, "host.sock");
    const markers = path.join(dir, "markers");
    const order: string[] = [];
    const sockets: net.Socket[] = [];
    const closes: Promise<unknown>[] = [];
    const children: { child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }[] = [];
    const tasks: Promise<void>[] = [];
    const failures: unknown[] = [];
    let handler: (socket: net.Socket, request: ExecHostRequest, id: string) => Promise<void>;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.push(socket);
      closes.push(
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
        }),
      );
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
        await handler(socket, JSON.parse(envelope.requestJson) as ExecHostRequest, envelope.id);
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
      await run({
        dir,
        socketPath,
        markers,
        order,
        children,
        onRequest: (next) => {
          handler = next;
        },
      });
      await Promise.all(tasks);
      expect(failures).toEqual([]);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(children.map(({ closed }) => closed));
      await Promise.all(closes);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

describe.runIf(process.platform !== "win32")("exec host real UDS boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(timers, "setTimeout").mockImplementation(setTimeout);
    vi.spyOn(timers, "clearTimeout").mockImplementation(clearTimeout);
    syncBuiltinESMExports();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    syncBuiltinESMExports();
  });

  it.each([
    [30_000, 45_000],
    [1_000, 20_000],
  ])(
    "receives a late reply within command budget %s plus approval and grace",
    async (timeoutMs, elapsed) => {
      await withExecPeer(async ({ socketPath, onRequest }) => {
        const received = createDeferred<net.Socket>();
        onRequest(async (socket) => {
          received.resolve(socket);
        });
        const controller = new AbortController();
        const completed = vi.fn();
        const pending = requestExecHostViaSocket({
          socketPath,
          token,
          request: { command: ["/bin/echo", "done"], timeoutMs },
          signal: controller.signal,
        }).then(completed);
        try {
          const socket = await received.promise;
          await vi.advanceTimersByTimeAsync(elapsed);
          expect(completed).not.toHaveBeenCalled();
          socket.end(`${JSON.stringify({ type: "exec-res", ...success })}\n`);
          await pending;
          expect(completed).toHaveBeenCalledExactlyOnceWith(success);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          controller.abort();
          await pending;
        }
      });
    },
  );

  it("characterizes a missing socket before any request can execute", async () => {
    await withTestDir({ prefix: "oc-exec-", parentDir: "/tmp" }, async (dir) => {
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
    });
  });

  it.each([success, denial])(
    "receives a complete response after request half-close: $ok",
    async (response) => {
      await withExecPeer(async ({ socketPath, onRequest, order }) => {
        const request = {
          command: ["/bin/echo", "done"],
          cwd: "/tmp",
          needsScreenRecording: false,
        };
        onRequest(async (socket, received, id) => {
          expect(received).toEqual(request);
          // Respond on a later event-loop turn: write EOF is not response EOF.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          order.push("response");
          socket.end(`${JSON.stringify({ type: "exec-res", id, ...response })}\n`);
        });
        await expect(
          requestExecHostViaSocket({ socketPath, token, request, timeoutMs: 1_000 }),
        ).resolves.toEqual(response);
        expect(order).toEqual(["request-half-closed", "response"]);
      });
    },
  );

  it.each(["close", "malformed matching response", "timeout"] as const)(
    "characterizes the outcome after a signed request starts a child and then %s",
    async (fault) => {
      await withExecPeer(async ({ dir, socketPath, markers, order, children, onRequest }) => {
        const command = [
          "/bin/sh",
          "-c",
          'printf "START\\n" >> "$1"; printf "START\\n"; read -r release; printf "COMPLETE\\n" >> "$1"',
          "exec-host-proof",
          markers,
        ];
        const request = { command, cwd: dir, timeoutMs: 5_000, needsScreenRecording: false };
        const release = createDeferred();
        const faultReady = createDeferred();
        const childCloses: Promise<unknown>[] = [];
        onRequest(async (socket, received, id) => {
          expect(received).toEqual(request);
          const [executable, ...args] = received.command;
          assert.ok(executable, "Exec peer received an empty command");
          const child = spawn(executable, args, {
            cwd: received.cwd!,
            env: { HOME: dir, PATH: "/usr/bin:/bin" },
            stdio: "pipe",
          });
          const closed = once(child, "close");
          children.push({ child, closed });
          childCloses.push(closed);
          try {
            const [started] = await Promise.race([
              once(child.stdout, "data"),
              closed.then(() => {
                throw new Error("Child exited before START");
              }),
            ]);
            expect(String(started)).toBe("START\n");
            expect(await fs.readFile(markers, "utf8")).toBe("START\n");
            order.push("child-started");
            if (fault === "close") {
              order.push("response-dropped");
              socket.end();
            } else if (fault === "malformed matching response") {
              order.push("malformed-response");
              socket.write(`${JSON.stringify({ type: "exec-res", id, ok: true })}\n`);
            }
            faultReady.resolve();
            await release.promise;
          } finally {
            child.stdin.end("finish\n");
            expect(await closed).toEqual([0, null]);
          }
          order.push("child-completed");
        });
        try {
          const pending = requestExecHostViaSocket({
            socketPath,
            token,
            request,
            timeoutMs: 1_000,
          });
          await faultReady.promise;
          if (fault !== "close") {
            await vi.advanceTimersByTimeAsync(1_000);
          }
          const result = await pending;
          expect(result).toEqual({
            ok: false,
            error:
              fault === "close"
                ? {
                    code: "UNKNOWN",
                    reason: "response-lost",
                    message:
                      "UNKNOWN: macOS app exec host response was lost; execution outcome is unknown",
                  }
                : {
                    code: "TIMEOUT",
                    reason: "timeout",
                    message:
                      "TIMEOUT: macOS app exec host response timed out; execution outcome is unknown",
                  },
          });
          order.push("client-outcome-unknown");
          expect(await fs.readFile(markers, "utf8")).toBe("START\n");
        } finally {
          release.resolve();
          await Promise.all(childCloses);
        }
        expect(await fs.readFile(markers, "utf8")).toBe("START\nCOMPLETE\n");
        expect(order).toEqual([
          "request-half-closed",
          "child-started",
          ...(fault === "timeout"
            ? []
            : [fault === "close" ? "response-dropped" : "malformed-response"]),
          "client-outcome-unknown",
          "child-completed",
        ]);
      });
    },
  );
});
