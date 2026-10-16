import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlPayload,
  ServiceChildStart,
} from "./service-child-protocol.js";

describe.skipIf(process.platform === "win32")("POSIX anchor input lifetime", () => {
  it.for(["host-loss", "end-before-eof", "end-after-eof", "default-eof"] as const)(
    "%s distinguishes protocol EOF from host loss",
    async (mode, context) => {
      const generation = randomUUID();
      const argv = resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor),
      );
      // Observe the real input event without changing the anchor's stream handling.
      const probe = `data:text/javascript,${encodeURIComponent(
        'import { writeSync } from "node:fs"; process.stdin.once("end", () => writeSync(6, "input-eof\\n"));',
      )}`;
      const child = spawn(
        process.execPath,
        [...argv.slice(0, -1), "--import", probe, argv.at(-1)!],
        { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "ipc", "pipe"] },
      );
      const exited = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
      const disconnected = createDeferredCore();
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      child.once("error", exited.reject);
      child.once("disconnect", () => disconnected.resolve());
      const closed = Promise.all([
        exited.promise,
        disconnected.promise,
        ...child.stdio.flatMap((stream) =>
          stream
            ? [
                new Promise<void>((resolve) => {
                  stream.once("close", resolve);
                }),
              ]
            : [],
        ),
      ]).then(([result]) => result);
      const control = child.stdio[3];
      const lineage = child.stdio[4];
      const inputProbe = child.stdio.at(6);
      const ready = createDeferredCore();
      const inputEof = createDeferredCore();
      const messages: ServiceChildAnchorMessage[] = [];
      let sequence = 0;
      let stdout = "";
      let stderr = "";
      let pending = "";
      const run = async () => {
        if (!(control instanceof Duplex) || !(lineage instanceof Duplex) || !inputProbe) {
          throw new Error("Missing anchor fixture pipes");
        }
        const send = (message: ServiceChildControlPayload) => {
          control.write(`${JSON.stringify({ ...message, generation, sequence: ++sequence })}\n`);
        };
        control.on("error", () => {});
        child.stdin!.on("error", () => {});
        inputProbe.once("data", () => inputEof.resolve());
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("child-ready\n")) {
            ready.resolve();
          }
        });
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        lineage.once("end", () => {
          if (!control.destroyed) {
            send({ type: "lineage-closed" });
          }
        });
        lineage.resume();
        control.setEncoding("utf8").on("data", (chunk: string) => {
          pending += chunk;
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline < 0) {
              break;
            }
            // This fixture's spawned anchor is the sole control-channel writer.
            const message = JSON.parse(pending.slice(0, newline)) as ServiceChildAnchorMessage;
            pending = pending.slice(newline + 1);
            messages.push(message);
            if (message.type === "prepared") {
              // Ordered control frames prove that this end request precedes launch and EOF.
              if (mode === "end-before-eof") {
                send({ type: "stdin-end" });
              }
              send({ type: "launch" });
            } else if (message.type === "closing") {
              send({ type: "closing-ack", closingSequence: message.sequence });
            } else if (message.type === "startup-error") {
              send({ type: "startup-error-ack" });
            }
          }
        });
        const start: ServiceChildStart = {
          type: "prepare",
          generation,
          command: process.execPath,
          args: [
            "-e",
            'process.on("SIGTERM", () => {}); let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; }); process.stdin.once("end", () => process.stdout.write("synthetic-refusal:" + input + "\\n", () => process.exit(0))); process.stdout.write("child-ready\\n");',
          ],
          env: {},
          stdinMode: "pipe-open",
          controlFd: 3,
          lineageFd: 4,
          acknowledgeClosing: true,
          ...(mode === "default-eof" ? {} : { terminateOnHostLoss: true }),
        };
        child.send(start);
        await awaitGateBeforeSettlement(
          ready.promise,
          closed,
          "Anchor closed before child startup",
        );
        child.stdin!.end("flushed-input");
        await awaitGateBeforeSettlement(inputEof.promise, closed, "Anchor closed before input EOF");
        if (mode === "host-loss") {
          child.disconnect();
        } else if (mode === "end-after-eof") {
          send({ type: "stdin-end" });
        }
        const result = await closed;
        if (mode === "host-loss") {
          expect(result, stderr).toEqual({ code: null, signal: "SIGKILL" });
          expect(stdout).toBe("child-ready\n");
          expect(messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "closing", reason: "parent-lost" }),
            ]),
          );
        } else {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expect(stdout).toBe("child-ready\nsynthetic-refusal:flushed-input\n");
          expect(messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "root-result", code: 0, signal: null }),
              expect.objectContaining({ type: "closing" }),
            ]),
          );
        }
      };
      try {
        await withinTest(run(), context.signal);
      } finally {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            expect(hasErrnoCode(error, "ESRCH")).toBe(true);
          }
        }
        await closed;
      }
    },
  );
});
