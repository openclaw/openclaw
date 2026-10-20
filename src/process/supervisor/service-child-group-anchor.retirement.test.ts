import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createAnchorFixture } from "./anchor-protocol.test-support.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import type { ServiceChildAnchorMessage } from "./service-child-protocol.js";

it
  .skipIf(process.platform === "win32")
  .each([
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
    "forced-matching",
    "forced-missing",
    "forced-control-lost",
    "forced-legacy-host",
  ] as const)(
  "retires gracefully only after the closing receipt is acknowledged (%s)",
  async (acknowledgement) => {
    const forced = acknowledgement.startsWith("forced-");
    const mode = acknowledgement.replace("forced-", "");
    const legacy = mode === "legacy-host";
    const { child, generation, control, messages, send, exited, onMessage, nextSequence } =
      createAnchorFixture({ legacy });
    let prearmedSequence: number | undefined;
    let forcedCancellationAt = 0;
    const startupFailure = acknowledgement === "pre-armed" || acknowledgement === "startup-error";
    const invalidReceipt = [
      "stale-generation",
      "wrong-receipt",
      "malformed-receipt",
      "non-monotonic",
    ].includes(acknowledgement);
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const reply = (closingSequence: unknown, replyGeneration: string, sequence: number) =>
      control.write(
        `${JSON.stringify({ type: "closing-ack", generation: replyGeneration, sequence, closingSequence })}\n`,
      );
    onMessage((message) => {
      if (message.type === "ready" && forced) {
        forcedCancellationAt = performance.now();
        send({ type: "cancel", signal: "SIGKILL" });
      }
      if (message.type === "startup-error") {
        if (acknowledgement === "pre-armed") {
          // Both frames share the ordered control channel: the early ACK must
          // be consumed before startup acknowledgement can begin retirement.
          prearmedSequence = message.sequence + 1;
          reply(prearmedSequence, generation, nextSequence());
        }
        send({ type: "startup-error-ack" });
      }
      if (message.type !== "closing") {
        return;
      }
      if (mode === "control-lost") {
        control.destroy();
      } else if (acknowledgement === "relay-lost") {
        child.disconnect();
      } else if (mode !== "missing" && mode !== "pre-armed" && acknowledgement !== "legacy-host") {
        reply(
          acknowledgement === "malformed-receipt"
            ? String(message.sequence)
            : acknowledgement === "wrong-receipt"
              ? message.sequence - 1
              : message.sequence,
          acknowledgement === "stale-generation" ? `${generation}-stale` : generation,
          acknowledgement === "non-monotonic" ? 0 : nextSequence(),
        );
        if (invalidReceipt) {
          // EOF follows the invalid frame on the same ordered control pipe.
          control.end();
        }
      }
    });
    try {
      child.send({
        type: "start",
        generation,
        command: startupFailure ? `/openclaw-missing-command-${generation}` : process.execPath,
        args: ["-e", forced ? "setInterval(() => {}, 1000)" : ""],
        env: {},
        stdinMode: "pipe-closed",
        controlFd: 3,
        ...(legacy ? {} : { lineageFd: 4 }),
        ...(acknowledgement === "legacy-host"
          ? {}
          : { acknowledgeClosing: acknowledgement !== "unsupported-capability" }),
      });
      const result = await exited;
      if (acknowledgement === "forced-legacy-host") {
        expect(result, stderr).toEqual({ code: null, signal: "SIGKILL" });
        expect(messages.some((message) => message.type === "closing")).toBe(false);
        return;
      }
      if (acknowledgement === "unsupported-capability") {
        expect(result, stderr).toEqual({ code: 1, signal: null });
        expect(messages).toEqual([]);
        return;
      }
      const expectMessage = (message: Partial<ServiceChildAnchorMessage>) =>
        expect(messages, stderr).toContainEqual(
          expect.objectContaining({ ...message, generation }),
        );
      expectMessage(
        forced
          ? { type: "ready" }
          : startupFailure
            ? { type: "startup-error" }
            : { type: "root-result", code: 0, signal: null },
      );
      expectMessage({ type: "closing" });
      if (acknowledgement === "pre-armed") {
        expect(messages.find((message) => message.type === "closing")?.sequence).toBe(
          prearmedSequence,
        );
      }
      if (startupFailure) {
        expect(messages.find((message) => message.type === "startup-error")).toMatchObject({
          anchorPid: child.pid,
        });
      }
      if (forced) {
        expect(result, stderr).toEqual({ code: null, signal: "SIGKILL" });
        if (acknowledgement === "forced-missing") {
          expect(performance.now() - forcedCancellationAt).toBeGreaterThanOrEqual(
            GRACEFUL_CANCEL_TIMEOUT_MS,
          );
        }
        return;
      }
      if (["matching", "startup-error", "legacy-host"].includes(acknowledgement)) {
        expect(result, stderr).toEqual({ code: 0, signal: null });
      } else {
        expect(
          result.code,
          "An unacknowledged closing receipt must not retire gracefully",
        ).not.toBe(0);
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      control.destroy();
      child.stdio[4]?.destroy();
    }
  },
);
