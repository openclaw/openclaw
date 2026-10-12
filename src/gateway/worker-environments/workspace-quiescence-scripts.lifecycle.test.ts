import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { workspaceQuiescenceArgv } from "./workspace-quiescence-scripts.js";

it("closes the generated Windows lease database when admission fails", () => {
  const nonce = "a".repeat(32);
  const command = workspaceQuiescenceArgv(
    "/workspace",
    { action: "acquire", nonce, timeoutMs: 10_000 },
    "shared-host",
    "owned",
  );
  const close = vi.fn();
  expect(() =>
    runInNewContext(command[2]!, {
      process: { argv: [process.execPath, ...command.slice(3)], platform: "win32" },
      performance: { now: () => 0 },
      require: (name: string) => {
        if (name === "node:crypto") {
          return crypto;
        }
        if (name === "node:path") {
          return path;
        }
        if (name === "node:os") {
          return { homedir: () => "/home/worker" };
        }
        if (name === "node:fs") {
          return { realpathSync: (value: string) => value, mkdirSync() {} };
        }
        if (name === "node:child_process") {
          return {};
        }
        if (name === "node:sqlite") {
          return {
            DatabaseSync: class {
              close = close;
              isTransaction = false;
              exec() {
                throw new Error("lease admission failed");
              }
            },
          };
        }
        throw new Error("unexpected dependency: " + name);
      },
    }),
  ).toThrow("lease admission failed");
  expect(close).toHaveBeenCalledOnce();
});

it("retires the generated sidecar transport and rejects already-queued acquisition", () => {
  const nonce = "a".repeat(32);
  const command = workspaceQuiescenceArgv(
    "/workspace",
    { action: "acquire", nonce, timeoutMs: 10_000 },
    "shared-host",
    "owned",
  );
  const events = new EventEmitter();
  const files = new Map<string, string>();
  const timers = new Set<() => void>();
  const forcedExit = vi.fn(() => {
    throw new Error("unexpected forced exit");
  });
  const child = {
    argv: [process.execPath, ...command.slice(3)],
    pid: 1234,
    platform: "linux",
    getuid: () => 1000,
    connected: true,
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    stdin: { destroy: vi.fn() },
    send: vi.fn(),
    exit: forcedExit,
    reallyExit: forcedExit,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    disconnect: vi.fn(() => {
      child.connected = false;
      events.emit("disconnect");
    }),
  };
  const fs = {
    realpathSync: (value: string) => value,
    mkdirSync() {},
    chmodSync() {},
    readdirSync: () => [],
    readFileSync: (name: string) => {
      const value = files.get(name);
      if (value === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT", path: name });
      }
      return value;
    },
    writeFileSync: (name: string, value: string) => files.set(name, value),
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlinkSync: (name: string) => files.delete(name),
  };
  runInNewContext(command[2]!, {
    process: child,
    performance: { now: () => 0 },
    require: (name: string) => {
      if (name === "node:process" || name === "process") {
        return child;
      }
      if (name === "node:crypto") {
        return crypto;
      }
      if (name === "node:path") {
        return path;
      }
      if (name === "node:fs") {
        return fs;
      }
      if (name === "node:os") {
        return { homedir: () => "/home/worker" };
      }
      if (name === "node:child_process") {
        return { execFileSync: () => "synthetic start" };
      }
      throw new Error("unexpected dependency: " + name);
    },
    setTimeout: (callback: () => void) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  });
  expect(files.size).toBe(1);
  expect(timers.size).toBe(1);
  events.emit("message", {
    type: "workspace-quiescence-control",
    action: "release",
    nonce,
    id: "release",
  });
  expect(files.size).toBe(0);
  expect(child.send).toHaveBeenLastCalledWith({
    type: "workspace-quiescence-result",
    action: "release",
    nonce,
    id: "release",
  });
  const queuedMessage = events.listeners("message")[0]!;
  events.emit("message", { type: "workspace-quiescence-retire", nonce });
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(child.stdin.destroy).toHaveBeenCalledOnce();
  expect(timers.size).toBe(0);
  expect(events.listenerCount("message")).toBe(0);
  expect(events.listenerCount("disconnect")).toBe(0);
  const replies = child.send.mock.calls.length;
  queuedMessage({
    type: "workspace-quiescence-control",
    action: "acquire",
    nonce: "b".repeat(32),
    timeoutMs: 10_000,
    id: "late",
  });
  expect(files.size).toBe(0);
  expect(child.send).toHaveBeenCalledTimes(replies);
  expect(forcedExit).not.toHaveBeenCalled();
});
