import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as relaySpawn from "../spawn-broker/relay-integration.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { readLines } from "./service-child-group-anchor.preparation.test-support.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlMessage,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "confirms process-group retirement completed before the deadline while the Node host was blocked",
  async ({ signal }) => {
    // Native custody has no independent reaper to exercise while this host is blocked.
    mockProcessPlatform("darwin");
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
      setTimeout(() => process.exit(2), ${GRACEFUL_CANCEL_TIMEOUT_MS * 3});
      setInterval(() => {
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
    let relayExit: Promise<unknown> | undefined;
    let controlClose: Promise<unknown> | undefined;
    let relay: ChildProcess | undefined;
    let adapter: Awaited<ReturnType<typeof createServiceChildRelayAdapter>>["adapter"] | undefined;
    let anchorPid: number | undefined;
    let ackAt: number | undefined;
    let resumedAt = 0;
    const delivered: string[] = [];
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          once(observer, "message"),
          observerExit,
          "observer exited before startup",
        ),
        signal,
      );
      const spawnRelay = relaySpawn.spawnServiceChildRelay;
      vi.spyOn(relaySpawn, "spawnServiceChildRelay").mockImplementation((params) => {
        const result = spawnRelay(params);
        relay = result.child;
        relayExit = once(relay, "exit").then(() => delivered.push("relay-exit"));
        const control = relay.stdio[3];
        if (!(control instanceof Duplex)) {
          throw new Error("Expected the private control pipe");
        }
        controlClose = once(control, "close").then(() => delivered.push("control-close"));
        readLines(control, (line) => {
          const message = JSON.parse(line) as ServiceChildAnchorMessage;
          if (message.type === "ready") {
            anchorPid = message.anchorPid;
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
        return result;
      });
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
      const results = await Promise.all([adapter.wait(), adapter.waitForExtinction()]);
      await Promise.all([relayExit, controlClose]);
      expect((await observerExit)[0]).toBe(0);
      const observed = JSON.parse(readFileSync(receipt, "utf8")) as Record<
        "ackAt" | "retiredAt",
        number
      >;
      expect(observed.ackAt).toBe(ackAt);
      expect(observed.retiredAt - observed.ackAt).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(resumedAt - observed.ackAt).toBeGreaterThanOrEqual(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(delivered.slice(0, 2)).toEqual(["ack-flushed", "resumed"]);
      expect(delivered.indexOf("relay-exit")).toBeGreaterThan(delivered.indexOf("resumed"));
      expect(delivered.indexOf("control-close")).toBeGreaterThan(delivered.indexOf("resumed"));
      expect(results).toEqual([{ code: 0, signal: null }, undefined]);
    } finally {
      observer.kill("SIGKILL");
      await observerExit;
      if (relay) {
        adapter?.kill("SIGKILL");
        relay.kill("SIGTERM");
        await relayExit;
      }
      adapter?.dispose();
    }
  },
);
