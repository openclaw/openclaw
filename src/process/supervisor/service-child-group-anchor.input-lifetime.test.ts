import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAnchorFixture } from "./anchor-protocol.test-support.js";
import { waitForAnchorClosure } from "./service-child-group-anchor.preparation.test-support.js";
import type { ServiceChildAnchorMessage, ServiceChildStart } from "./service-child-protocol.js";

it
  .skipIf(process.platform === "win32")
  .for(["host-loss", "end-before-eof", "end-after-eof", "default-eof"] as const)(
  "%s distinguishes protocol EOF from host loss",
  async (mode, context) => {
    // Observe the real input event without changing the anchor's stream handling.
    const probe = `data:text/javascript,${encodeURIComponent(
      'import { writeSync } from "node:fs"; process.stdin.once("end", () => writeSync(6, "input-eof\\n"));',
    )}`;
    const { child, generation, messages, send, exited, onMessage } = createAnchorFixture({
      preload: probe,
    });
    const closed = waitForAnchorClosure(child, exited);
    const inputProbe = child.stdio.at(6);
    const ready = createDeferredCore();
    const inputEof = createDeferredCore();
    let stdout = "";
    let stderr = "";
    const run = async () => {
      assert(inputProbe, "Missing anchor input probe");
      child.stdin!.on("error", () => {});
      inputProbe.once("data", () => inputEof.resolve());
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("child-ready\n")) {
          ready.resolve();
        }
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      onMessage((message) => {
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
      await awaitGateBeforeSettlement(ready.promise, closed, "Anchor closed before child startup");
      child.stdin!.end("flushed-input");
      await awaitGateBeforeSettlement(inputEof.promise, closed, "Anchor closed before input EOF");
      if (mode === "host-loss") {
        child.disconnect();
      } else if (mode === "end-after-eof") {
        send({ type: "stdin-end" });
      }
      const result = await closed;
      const expectMessage = (message: Partial<ServiceChildAnchorMessage>) =>
        expect(messages).toContainEqual(expect.objectContaining(message));
      if (mode === "host-loss") {
        expect(result, stderr).toEqual({ code: null, signal: "SIGKILL" });
        expect(stdout).toBe("child-ready\n");
        expectMessage({ type: "closing", reason: "parent-lost" });
      } else {
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(stdout).toBe("child-ready\nsynthetic-refusal:flushed-input\n");
        expectMessage({ type: "root-result", code: 0, signal: null });
        expectMessage({ type: "closing" });
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
