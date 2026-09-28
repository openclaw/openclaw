import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlMessage,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

const hooks = vi.hoisted(() => ({
  spawned: undefined as ((child: ChildProcess, args?: readonly string[]) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      hooks.spawned?.(child, args[1]);
      return child;
    },
  };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  hooks.spawned = undefined;
});

it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "confirms native retirement completed before the deadline while the Node host was blocked",
  async () => {
    const root = tempDirs.make("openclaw-retirement-dispatch-");
    const input = path.join(root, "observe.json");
    const receipt = path.join(root, "retired.json");
    const observer = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require("node:fs");
      const [input, receipt] = process.argv.slice(1);
      const stop = setTimeout(() => process.exit(2), ${GRACEFUL_CANCEL_TIMEOUT_MS * 3});
      const poll = setInterval(() => {
        if (!fs.existsSync(input)) {
          return;
        }
        const { anchorPid, ackAt } = JSON.parse(fs.readFileSync(input, "utf8"));
        try { process.kill(-anchorPid, 0); }
        catch (error) {
          // Darwin can report EPERM while an exited group leader awaits reaping.
          if (process.platform === "darwin" && error.code === "EPERM") {
            return;
          }
          if (error.code !== "ESRCH") {
            throw error;
          }
          fs.writeFileSync(receipt, JSON.stringify({ ackAt, retiredAt: Date.now() }));
          clearTimeout(stop);
          clearInterval(poll);
          process.exit(0);
        }
      }, 10);
      process.send({ ready: true });
    `,
        input,
        receipt,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const observerExit = once(observer, "exit");
    const relayExit = createDeferred();
    const controlClose = createDeferred();
    let relay: ChildProcess | undefined;
    let adapter: Awaited<ReturnType<typeof createServiceChildRelayAdapter>>["adapter"] | undefined;
    let anchorPid: number | undefined;
    let ackAt: number | undefined;
    let resumedAt = 0;
    const delivered: string[] = [];
    const relayArgv = resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildRelay),
    );
    try {
      await withTestTimeout(
        once(observer, "message"),
        GRACEFUL_CANCEL_TIMEOUT_MS,
        "observer startup",
      );
      hooks.spawned = (child, args) => {
        if (
          !args ||
          args.length !== relayArgv.length ||
          args.some((arg, i) => arg !== relayArgv[i])
        ) {
          return;
        }
        relay = child;
        child.once("exit", () => {
          delivered.push("relay-exit");
          relayExit.resolve();
        });
        const control = child.stdio[3];
        if (!(control instanceof Duplex)) {
          throw new Error("Expected the private control pipe");
        }
        control.once("close", () => {
          delivered.push("control-close");
          controlClose.resolve();
        });
        let pending = "";
        control.on("data", (chunk: Buffer) => {
          pending += chunk.toString();
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline < 0) {
              return;
            }
            // The real anchor is the sole writer on its private protocol channel.
            const message = JSON.parse(pending.slice(0, newline)) as ServiceChildAnchorMessage;
            pending = pending.slice(newline + 1);
            if (message.type === "ready") {
              anchorPid = message.anchorPid;
            }
          }
        });
        const write = control.write.bind(control);
        control.write = ((
          chunk: string,
          encoding: BufferEncoding,
          callback: (error?: Error | null) => void,
        ) => {
          const message = JSON.parse(chunk) as ServiceChildControlMessage;
          return write(chunk, encoding, (error) => {
            callback(error);
            if (message.type !== "closing-ack" || ackAt !== undefined || error) {
              return;
            }
            ackAt = Date.now();
            writeFileSync(`${input}.tmp`, JSON.stringify({ anchorPid, ackAt }));
            renameSync(`${input}.tmp`, input);
            delivered.push("ack-flushed");
            // Stall only after kernel acceptance; the independent observer keeps running.
            Atomics.wait(
              new Int32Array(new SharedArrayBuffer(4)),
              0,
              0,
              GRACEFUL_CANCEL_TIMEOUT_MS + 1_000,
            );
            resumedAt = Date.now();
            delivered.push("resumed");
          });
        }) as typeof control.write;
      };
      const startup = await createServiceChildRelayAdapter({
        command: process.execPath,
        args: ["-e", "process.stdout.write('finished\\n')"],
        cwd: root,
        env: { OPENCLAW_STATE_DIR: root },
        stdinMode: "pipe-closed",
        oomScoreWrapperSelected: false,
      });
      adapter = startup.adapter;
      await startup.ready;
      const results = await Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
      await Promise.all([relayExit.promise, controlClose.promise]);
      expect((await observerExit)[0]).toBe(0);
      const observed = JSON.parse(readFileSync(receipt, "utf8")) as {
        ackAt: number;
        retiredAt: number;
      };
      expect(observed.ackAt).toBe(ackAt);
      expect(observed.retiredAt - observed.ackAt).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(resumedAt - observed.ackAt).toBeGreaterThanOrEqual(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(delivered.slice(0, 2)).toEqual(["ack-flushed", "resumed"]);
      expect(delivered.indexOf("relay-exit")).toBeGreaterThan(delivered.indexOf("resumed"));
      expect(delivered.indexOf("control-close")).toBeGreaterThan(delivered.indexOf("resumed"));
      expect(results).toEqual([
        { status: "fulfilled", value: { code: 0, signal: null } },
        { status: "fulfilled", value: undefined },
      ]);
    } finally {
      hooks.spawned = undefined;
      observer.kill("SIGKILL");
      await observerExit;
      if (relay) {
        adapter?.kill("SIGKILL");
        relay.kill("SIGTERM");
        await withTestTimeout(relayExit.promise, GRACEFUL_CANCEL_TIMEOUT_MS * 3, "relay cleanup");
      }
      adapter?.dispose();
    }
  },
);
