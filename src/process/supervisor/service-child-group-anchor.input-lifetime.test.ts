import { once } from "node:events";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createAnchorFixture } from "./anchor-protocol.test-support.js";
import { waitForAnchorClosure } from "./service-child-group-anchor.preparation.test-support.js";
import type { ServiceChildStart } from "./service-child-protocol.js";

it
  .skipIf(process.platform === "win32")
  .for(["host-loss", "end-before-eof", "end-after-eof", "default-eof"] as const)(
  "%s distinguishes protocol EOF from host loss",
  async (mode, context) => {
    const { child, generation, messages, send, exited, onMessage } = createAnchorFixture({
      preload: `data:text/javascript,${encodeURIComponent(
        'import { writeSync } from "node:fs"; process.stdin.once("end", () => writeSync(6, "input-eof\\n"));',
      )}`,
    });
    const closed = waitForAnchorClosure(child, exited);
    context.onTestFinished(async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          expect(hasErrnoCode(error, "ESRCH")).toBe(true);
        }
      }
      await closed;
    });
    let stdout = "";
    child.stdin!.on("error", () => {});
    const inputEof = once(child.stdio.at(6)!, "data");
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout === "child-ready\n") {
        child.stdin!.end("flushed-input");
      }
    });
    child.stderr!.resume();
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
    child.send({
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
    } satisfies ServiceChildStart);
    await awaitGateBeforeSettlement(inputEof, closed, "Anchor closed before input EOF");
    if (mode === "host-loss") {
      child.disconnect();
    } else if (mode === "end-after-eof") {
      send({ type: "stdin-end" });
    }
    const hostLost = mode === "host-loss";
    expect([await closed, stdout]).toEqual([
      hostLost ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
      hostLost ? "child-ready\n" : "child-ready\nsynthetic-refusal:flushed-input\n",
    ]);
    const reason = messages.find((m) => m.type === "closing")?.reason;
    expect(reason).toBe(hostLost ? "parent-lost" : "lineage-lost");
    if (!hostLost) {
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "root-result", code: 0, signal: null }),
      );
    }
  },
);
