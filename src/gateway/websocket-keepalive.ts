import type { Socket } from "node:net";

export type WebSocketKeepaliveSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  ping(data?: undefined, mask?: undefined, callback?: (error?: Error) => void): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong" | "close", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  terminate(): void;
};

type PingWrite = { pingWriteState: "pending" | "completed" | "failed" };
export type WebSocketHeartbeatDiagnostics = PingWrite & {
  lastPongAgeMs: number | undefined;
  bufferedBytes: number;
};

/** Keep idle transports active; only the connection owner may impose a pong deadline. */
export function startWebSocketKeepalive(
  socket: WebSocketKeepaliveSocket,
  onMissedPong?: (diagnostics: WebSocketHeartbeatDiagnostics) => void,
  transport?: Pick<Socket, "setTimeout" | "on" | "off" | "timeout">,
): () => void {
  let awaitingPong: PingWrite | undefined;
  let lastPongAt: number | undefined;
  let pongDeadline: number | undefined;
  let writeTimeoutActive = false;
  const previousTimeout = transport?.timeout ?? 0;
  const clearWriteTimeout = () => {
    if (writeTimeoutActive) {
      writeTimeoutActive = false;
      transport?.off("timeout", reportMissedPong);
      transport?.setTimeout(previousTimeout);
    }
  };
  const reportMissedPong = () => {
    if (awaitingPong) {
      onMissedPong?.({
        ...awaitingPong,
        lastPongAgeMs: lastPongAt === undefined ? undefined : performance.now() - lastPongAt,
        bufferedBytes: socket.bufferedAmount,
      });
    }
  };
  const onPong = () => {
    awaitingPong = undefined;
    pongDeadline = undefined;
    clearWriteTimeout();
    if (onMissedPong) {
      lastPongAt = performance.now();
    }
  };
  const stop = () => {
    clearInterval(timer);
    awaitingPong = undefined;
    clearWriteTimeout();
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  socket.on("pong", onPong);
  socket.once("close", stop);
  const timer = setInterval(() => {
    if (socket.readyState !== 1 /* OPEN */) {
      stop();
      return;
    }
    // Stream peers can pause reads for backpressure, delaying automatic pongs.
    // Their existing control connection and stream owner still govern revocation.
    if (awaitingPong && onMissedPong) {
      // A queued write is governed by transport inactivity, which accounts for
      // partial write progress. Incoming traffic also proves transport liveness;
      // slow-consumer volume limits remain owned by the Gateway send paths.
      // A flushed ping needs a pong regardless of unrelated incoming traffic.
      if (writeTimeoutActive || (pongDeadline !== undefined && performance.now() < pongDeadline)) {
        return;
      }
      reportMissedPong();
      return;
    }
    const attempt: PingWrite = { pingWriteState: "pending" };
    awaitingPong = attempt;
    pongDeadline = undefined;
    if (onMissedPong && transport) {
      writeTimeoutActive = true;
      transport.on("timeout", reportMissedPong);
      transport.setTimeout(25_000);
    }
    try {
      socket.ping(
        undefined,
        undefined,
        onMissedPong
          ? (error) => {
              // A late completion belongs to this attempt, never a later ping.
              if (awaitingPong !== attempt) {
                return;
              }
              attempt.pingWriteState = error ? "failed" : "completed";
              clearWriteTimeout();
              if (!error) {
                pongDeadline = performance.now() + 25_000;
              }
            }
          : undefined,
      );
    } catch {
      attempt.pingWriteState = "failed";
      clearWriteTimeout();
      // The socket owner handles transport failure and closes the connection.
    }
  }, 25_000);
  return stop;
}
