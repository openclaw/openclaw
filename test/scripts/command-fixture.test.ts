import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandFixture } from "../helpers/command-fixture.js";
import { createFixtureDiagnostics } from "../helpers/fixture-diagnostics.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";

const observer = vi.hoisted((): { onChild?: (child: ChildProcess) => void } => ({}));

// Observe the real leader's exit without replacing spawning or process cleanup.
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>();
  return {
    ...actual,
    runManagedCommand: (options: Parameters<typeof actual.runManagedCommand>[0]) =>
      actual.runManagedCommand({
        ...options,
        onReady(child) {
          options.onReady?.(child);
          observer.onChild?.(child);
        },
      }),
  };
});

describe.skipIf(process.platform === "win32")("POSIX command fixture output drainage", () => {
  const modes =
    process.platform === "linux"
      ? (["drain", "cancel", "cancel-live"] as const)
      : (["drain", "cancel"] as const);
  it.for(modes)(
    "settles descendant output after leader exit or live cancellation through %s",
    async (mode, context) => {
      const stop = new AbortController();
      const signal = context.signal;
      const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
      // Registered first so this observes the fixture's existing teardown hook, not only run().
      context.onTestFinished(() => {
        try {
          expect(diagnostics).toHaveBeenCalledTimes(mode === "drain" ? 0 : 1);
        } finally {
          diagnostics.mockRestore();
        }
      });
      const command = createCommandFixture({
        signal: AbortSignal.any([signal, stop.signal]),
        onTestFinished: context.onTestFinished,
      });
      command.enableDiagnostics("command-fixture-drainage").stage(mode);
      try {
        await command.lifetime.run(async () => {
          signal.throwIfAborted();
          const server = createServer();
          let completion: ReturnType<typeof command.run> | undefined;
          let socket: Socket | undefined;
          let reader: ReturnType<typeof createInterface> | undefined;
          const connected = createDeferred<Socket>();
          const cancelled = createDeferred<never>();
          // Observe early rejection while retaining the original awaited promises.
          void connected.promise.catch(() => {});
          void cancelled.promise.catch(() => {});
          const aborted = () => cancelled.reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          server.once("connection", (connection) => {
            socket = connection;
            connected.resolve(connection);
          });
          server.once("error", connected.reject);
          try {
            server.listen({ port: 0, host: "127.0.0.1", signal });
            await once(server, "listening", { signal });
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Missing fixture listener address");
            }
            const exited = createDeferred();
            const ready = createDeferred();
            let leader: ChildProcess | undefined;
            observer.onChild = (child) => {
              leader = child;
              child.once("exit", () => exited.resolve());
              child.stdout!.once("data", () => ready.resolve());
            };
            const descendant = `
process.title = "private fixture process title";
const socket = require("node:net").connect(${address.port}, "127.0.0.1", () => process.send("ready"));
require("node:readline").createInterface({ input: socket }).on("line", (line) => {
  if (line === "ping") socket.write("pong\\n");
  if (line === "release") {
    process.stderr.write("drained\\n");
    socket.end();
  }
});
`;
            completion = command.run(process.execPath, [
              "--eval",
              `
const child = require("node:child_process").spawn(process.execPath, ["--eval", ${JSON.stringify(descendant)}], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
child.once("message", () => {
  console.log(child.pid);
  ${mode === "cancel-live" ? "" : "child.disconnect(); child.unref();"}
});
`,
            ]);
            const connection = await Promise.race([connected.promise, cancelled.promise]);
            const lines = createInterface({ input: connection });
            reader = lines;
            await Promise.race([
              mode === "cancel-live" ? ready.promise : exited.promise,
              cancelled.promise,
            ]);
            // The descendant remains usable while it owns the final output pipe.
            const pong = new Promise<string>((resolve, reject) => {
              if (connection.destroyed) {
                reject(new Error("Descendant exited before its output drained"));
                return;
              }
              lines.once("line", resolve);
              lines.once("error", reject);
              connection.once("close", () =>
                reject(new Error("Descendant exited before acknowledging drainage")),
              );
              connection.once("error", reject);
            });
            connection.write("ping\n");
            expect(await Promise.race([pong, cancelled.promise])).toBe("pong");
            if (mode === "drain") {
              connection.end("release\n");
              const result = await completion;
              expect(result.error).toBeUndefined();
              expect(result.status).toBe(0);
              expect(result.stderr).toBe("drained\n");
            } else {
              stop.abort();
              const result = await completion;
              expect(result.error).toMatchObject({ code: "ABORT_ERR" });
              const descendantPid = Number(result.stdout.trim());
              expect(descendantPid).toBeGreaterThan(0);
              expect(isProcessAlive(descendantPid)).toBe(false);
              if (mode === "cancel-live") {
                expect(diagnostics).toHaveBeenCalledTimes(1);
                const reportText = String(diagnostics.mock.calls[0]?.[0]);
                const report = JSON.parse(reportText.slice("[fixture-lifecycle] ".length));
                expect(reportText).not.toContain("private fixture");
                expect(report.current).toMatchObject({ exitCode: null, signalCode: null });
                expect(report.current.processTree.processes).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      pid: leader?.pid,
                      threads: expect.arrayContaining([
                        expect.objectContaining({
                          tid: leader?.pid,
                          state: expect.stringMatching(/^[A-Z]$/u),
                          waitChannel: expect.stringMatching(/^[A-Za-z0-9_]{1,96}$/u),
                        }),
                      ]),
                    }),
                    expect.objectContaining({ pid: descendantPid, parentPid: leader?.pid }),
                  ]),
                );
                expect(isProcessAlive(leader?.pid ?? 0)).toBe(false);
              }
            }
          } finally {
            observer.onChild = undefined;
            signal.removeEventListener("abort", aborted);
            reader?.close();
            socket?.destroy();
            await completion;
            await new Promise<void>((resolve, reject) => {
              server.close((error?: NodeJS.ErrnoException) => {
                if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
          }
        });
      } finally {
        await command.lifetime.cleanup();
      }
    },
  );
});

class ObservedChild extends EventEmitter {
  pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = { closed: false };
  stderr = { closed: false };
  spawnargs = ["private command payload"];
}

describe("failure-only fixture diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps successful, expected nonzero, and expected signal settlements silent", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostics = createFixtureDiagnostics("fixture");
    for (const signal of [null, "SIGKILL"] as const) {
      const command = diagnostics.command("probe");
      const child = new ObservedChild();
      command.ready(child);
      child.emit("spawn");
      child.exitCode = signal ? null : 1;
      child.signalCode = signal;
      child.emit("exit");
      child.stdout.closed = child.stderr.closed = true;
      child.emit("close");
      command.settled();
      command.inputComplete();
    }
    expect(output).not.toHaveBeenCalled();
  });

  it("reports bounded safe metadata once without consuming output or inventing spawn", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(performance, "now").mockReturnValue(10);
    const diagnostics = createFixtureDiagnostics("fixture");
    diagnostics.stage("sparse-import");
    const command = diagnostics.command("probe", true);
    const child = new ObservedChild();
    command.ready(child);
    expect(child.listenerCount("data")).toBe(0);
    now.mockReturnValue(25);
    command.output("stdout", 3);
    command.output("stderr", 7);
    diagnostics.report("abort");
    command.settled(Object.assign(new Error("private error payload"), { code: "ABORT_ERR" }));
    command.inputComplete();
    diagnostics.report("failure");
    expect(output).toHaveBeenCalledTimes(1);
    const text = String(output.mock.calls[0]?.[0]);
    const report = JSON.parse(text.slice("[fixture-lifecycle] ".length));
    expect(report.records.map((record: { event: string }) => record.event)).toEqual([
      "stage",
      "command-start",
      "on-ready",
    ]);
    expect(report.current).toMatchObject({
      id: 1,
      role: "probe",
      stage: "sparse-import",
      pid: 42,
      elapsedMs: 15,
      stdoutClosed: false,
      stderrClosed: false,
      stdoutBytes: 3,
      stderrBytes: 7,
      input: "pending",
    });
    expect(text).not.toContain("private");
    expect(text).not.toContain("spawnargs");
  });

  it("records native lifecycle order and the existing input completion boundary", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostics = createFixtureDiagnostics("fixture");
    const command = diagnostics.command("probe", true);
    const child = new ObservedChild();
    command.ready(child);
    child.emit("spawn");
    child.exitCode = 0;
    child.emit("exit");
    child.stdout.closed = child.stderr.closed = true;
    child.emit("close");
    command.settled(Object.assign(new Error("failed"), { code: "ETIMEDOUT" }));
    command.inputComplete();
    diagnostics.report("failure");
    const report = JSON.parse(
      String(output.mock.calls[0]?.[0]).slice("[fixture-lifecycle] ".length),
    );
    expect(report.records.map((record: { event: string }) => record.event)).toEqual([
      "command-start",
      "on-ready",
      "spawn",
      "exit",
      "close",
      "managed-settled",
      "input-complete",
    ]);
    expect(report.current).toMatchObject({
      exitCode: 0,
      errorCode: "ETIMEDOUT",
      input: "settled",
    });
  });

  it("bounds retained events and labels while keeping the latest stage and child", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostics = createFixtureDiagnostics("n".repeat(300));
    for (let index = 0; index < 100; index++) {
      diagnostics.stage("s".repeat(300));
    }
    diagnostics.command("r".repeat(300)).settled({ code: "unsafe/path" });
    diagnostics.report("failure");
    const report = JSON.parse(
      String(output.mock.calls[0]?.[0]).slice("[fixture-lifecycle] ".length),
    );
    expect(report.records).toHaveLength(48);
    expect(report.dropped).toBe(54);
    expect(report.name).toHaveLength(96);
    expect(report.stage).toHaveLength(96);
    expect(report.current.role).toHaveLength(96);
    expect(report.current.errorCode).toBeUndefined();
  });
});
