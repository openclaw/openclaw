import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ServiceChildAnchorMessage } from "./service-child-protocol.js";

describe.skipIf(process.platform === "win32")("POSIX anchor retirement", () => {
  it.each([
    "matching",
    "missing",
    "stale-generation",
    "wrong-receipt",
    "malformed-receipt",
    "non-monotonic",
    "pre-armed",
    "control-lost",
    "relay-lost",
    "startup-error",
    "legacy-host",
    "unsupported-capability",
  ] as const)(
    "retires gracefully only after the closing receipt is acknowledged (%s)",
    async (acknowledgement) => {
      const generation = randomUUID();
      const child = spawn(
        process.execPath,
        resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor),
        ),
        { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"] },
      );
      const exited = createDeferredCore<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>();
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      child.once("error", exited.reject);
      const control = child.stdio[3];
      if (!(control instanceof Duplex)) {
        child.kill("SIGKILL");
        throw new Error("Expected the anchor's private control pipe");
      }
      const messages: ServiceChildAnchorMessage[] = [];
      let prearmedSequence: number | undefined;
      let outboundSequence = 0;
      const startupFailure = acknowledgement === "pre-armed" || acknowledgement === "startup-error";
      let pending = "";
      let stderr = "";
      child.stdout?.resume();
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      // A failed reply is observed through the anchor's terminal result, not an unhandled stream error.
      control.on("error", () => {});
      const reply = (closingSequence: unknown, replyGeneration: string, sequence: number) =>
        control.write(
          `${JSON.stringify({ type: "closing-ack", generation: replyGeneration, sequence, closingSequence })}\n`,
        );
      control.setEncoding("utf8").on("data", (chunk: string) => {
        pending += chunk;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) {
            return;
          }
          // SAFETY: this exact spawned anchor is the sole writer on its private control channel.
          const message = JSON.parse(pending.slice(0, newline)) as ServiceChildAnchorMessage;
          pending = pending.slice(newline + 1);
          messages.push(message);
          if (message.type === "startup-error") {
            if (acknowledgement === "pre-armed") {
              // Both frames share the ordered control channel: the early ACK must
              // be consumed before startup acknowledgement can begin retirement.
              prearmedSequence = message.sequence + 1;
              reply(prearmedSequence, generation, ++outboundSequence);
            }
            control.write(
              `${JSON.stringify({ type: "startup-error-ack", generation, sequence: ++outboundSequence })}\n`,
            );
          }
          if (message.type !== "closing") {
            continue;
          }
          if (acknowledgement === "control-lost") {
            control.destroy();
          } else if (acknowledgement === "relay-lost") {
            child.disconnect();
          } else if (
            acknowledgement !== "missing" &&
            acknowledgement !== "pre-armed" &&
            acknowledgement !== "legacy-host"
          ) {
            reply(
              acknowledgement === "malformed-receipt"
                ? String(message.sequence)
                : acknowledgement === "wrong-receipt"
                  ? message.sequence - 1
                  : message.sequence,
              acknowledgement === "stale-generation" ? `${generation}-stale` : generation,
              acknowledgement === "non-monotonic" ? 0 : ++outboundSequence,
            );
          }
        }
      });
      try {
        child.send({
          type: "start",
          generation,
          command: startupFailure ? `/openclaw-missing-command-${generation}` : process.execPath,
          args: ["-e", ""],
          env: {},
          stdinMode: "pipe-closed",
          controlFd: 3,
          ...(acknowledgement === "legacy-host"
            ? {}
            : { acknowledgeClosing: acknowledgement !== "unsupported-capability" }),
        });
        const result = await exited.promise;
        if (acknowledgement === "unsupported-capability") {
          expect(result, stderr).toEqual({ code: 1, signal: null });
          expect(messages).toEqual([]);
          return;
        }
        expect(messages, stderr).toEqual(
          expect.arrayContaining([
            expect.objectContaining(
              startupFailure
                ? { type: "startup-error", generation }
                : { type: "root-result", generation, code: 0, signal: null },
            ),
            expect.objectContaining({ type: "closing", generation }),
          ]),
        );
        if (acknowledgement === "pre-armed") {
          expect(messages.find((message) => message.type === "closing")?.sequence).toBe(
            prearmedSequence,
          );
        }
        if (
          acknowledgement === "matching" ||
          acknowledgement === "startup-error" ||
          acknowledgement === "legacy-host"
        ) {
          expect(result, stderr).toEqual({ code: 0, signal: null });
        } else {
          expect(
            result.code,
            "An unacknowledged closing receipt must not retire gracefully",
          ).not.toBe(0);
        }
      } finally {
        child.kill("SIGKILL");
        await exited.promise;
        control.destroy();
      }
    },
  );
});
