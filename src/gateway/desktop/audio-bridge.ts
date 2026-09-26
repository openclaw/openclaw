import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { rawDataToString } from "../../../packages/gateway-client/src/websocket-data.js";
import { WebSocket, WebSocketServer } from "../../../packages/gateway-client/src/websocket.js";
import { createOneTimeTicketStore } from "../../shared/one-time-ticket-store.js";
import { rejectWebSocketUpgrade } from "../../shared/websocket-upgrade-reject.js";
import { startWebSocketKeepalive } from "../websocket-keepalive.js";
import type { DesktopAudioSource } from "./managed-linux-audio.js";
import type { DesktopObserveRequester } from "./observe-requester.js";

const DESKTOP_AUDIO_PATH = "/desktop/audio";
// A quarter second of stereo PCM. Slow viewers disconnect instead of hearing stale audio.
const MAX_BUFFERED_BYTES = (48_000 * 2 * 2) / 4;
const audioWss = new WebSocketServer({ noServer: true, maxPayload: 128 });

type AudioObservation = {
  attach(ws: WebSocket): void;
  close(): void;
  isCurrent(): boolean;
};
const tickets = createOneTimeTicketStore<AudioObservation>({
  ttlMs: 60_000,
  onExpire: (entry) => entry.close(),
});

/** The authenticated screen observation, not its bearer ticket, owns audio authority. */
export function mintDesktopAudioObserver(params: {
  source: DesktopAudioSource;
  requester?: DesktopObserveRequester;
}) {
  const lifetime = new AbortController();
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let closeSocket: (() => void) | undefined;
  const isCurrent = () => !lifetime.signal.aborted && params.requester?.isCurrent() !== false;
  const close = () => {
    if (lifetime.signal.aborted) {
      return;
    }
    lifetime.abort();
    resolveReady(false);
    tickets.delete(minted.token);
    params.requester?.signal?.removeEventListener("abort", close);
    closeSocket?.();
  };
  const minted = tickets.mint({
    close,
    isCurrent,
    attach(ws) {
      let generation = 0;
      let captureAbort: AbortController | undefined;
      let transition: Promise<void> | undefined;
      let pending: (() => Promise<void>) | undefined;
      const schedule = (next: () => Promise<void>) => {
        pending = next;
        if (transition) {
          return;
        }
        transition = (async () => {
          while (pending) {
            const run = pending;
            pending = undefined;
            await run();
          }
        })()
          .catch(close)
          .finally(() => {
            transition = undefined;
          });
      };
      const stopKeepalive = startWebSocketKeepalive(ws);
      const sendState = (state: "started" | "stopped" | "error", message?: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ state, ...(message ? { message } : {}) }));
        }
      };
      const stop = () => {
        generation += 1;
        pending = undefined;
        captureAbort?.abort();
        captureAbort = undefined;
      };
      closeSocket = () => {
        stop();
        stopKeepalive();
        ws.close(1000, "desktop audio observation closed");
      };
      ws.once("close", () => {
        stop();
        stopKeepalive();
        // Closing audio must not close the screen, but this one-use audio session is retired.
        close();
      });
      ws.once("error", close);
      ws.on("message", (raw, binary) => {
        if (!isCurrent()) {
          close();
          return;
        }
        let value: unknown;
        try {
          value = binary ? undefined : JSON.parse(rawDataToString(raw));
        } catch {
          /* Invalid control frames retire this stream. */
        }
        if (
          !isRecord(value) ||
          Object.keys(value).length !== 1 ||
          (value.action !== "start" && value.action !== "stop")
        ) {
          ws.close(1008, "invalid desktop audio command");
          close();
          return;
        }
        if (value.action === "start" && captureAbort && !captureAbort.signal.aborted) {
          return;
        }
        stop();
        if (value.action === "stop") {
          sendState("stopped");
          return;
        }
        const currentGeneration = generation;
        const controller = new AbortController();
        captureAbort = controller;
        const current = () =>
          isCurrent() &&
          currentGeneration === generation &&
          !controller.signal.aborted &&
          ws.readyState === WebSocket.OPEN;
        // Serialize capture teardown and startup so repeated clicks never overlap recorders.
        schedule(async () => {
          if (!(await ready) || !current()) {
            return;
          }
          const signal = AbortSignal.any([lifetime.signal, controller.signal]);
          let capture: Awaited<ReturnType<DesktopAudioSource["start"]>> | undefined;
          try {
            capture = await params.source.start(signal, () => {
              if (!current()) {
                throw new Error("Desktop audio observation is no longer current");
              }
            });
            if (!current()) {
              return;
            }
            sendState("started");
            const stream = capture.stream;
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const cleanup = () => {
                signal.removeEventListener("abort", finish);
                stream.off("end", finish);
                stream.off("close", finish);
                stream.off("error", fail);
                stream.off("data", forward);
              };
              const finish = () => {
                if (settled) {
                  return;
                }
                settled = true;
                cleanup();
                resolve();
              };
              const fail = (error: Error) => {
                if (settled) {
                  return;
                }
                settled = true;
                cleanup();
                reject(error);
              };
              const forward = (chunk: Buffer) => {
                if (!current()) {
                  controller.abort();
                  return;
                }
                if (ws.bufferedAmount + chunk.length > MAX_BUFFERED_BYTES) {
                  sendState(
                    "error",
                    "Audio connection is too slow. Mute and reconnect the desktop to try again.",
                  );
                  controller.abort();
                  ws.close(1013, "desktop audio backpressure");
                  return;
                }
                ws.send(chunk, { binary: true });
              };
              signal.addEventListener("abort", finish, { once: true });
              stream.once("end", finish);
              stream.once("close", finish);
              stream.once("error", fail);
              stream.on("data", forward);
              if (signal.aborted || stream.destroyed || stream.readableEnded) {
                finish();
              }
            });
            if (current()) {
              sendState(
                "error",
                "Desktop audio stopped. Check the remote audio service and reconnect.",
              );
            }
          } catch {
            if (current()) {
              sendState(
                "error",
                "Desktop audio is unavailable. Check the remote audio service and reconnect.",
              );
            }
          } finally {
            controller.abort();
            await capture?.stop();
          }
        });
      });
      if (!isCurrent()) {
        closeSocket();
      }
    },
  });
  params.requester?.signal?.addEventListener("abort", close, { once: true });
  if (params.requester?.signal?.aborted || !isCurrent()) {
    close();
  }
  return {
    descriptor: {
      wsPath: DESKTOP_AUDIO_PATH + "?token=" + minted.token,
      encoding: "pcm-s16le" as const,
      sampleRate: 48_000 as const,
      channels: 2 as const,
    },
    activate() {
      if (isCurrent()) {
        resolveReady(true);
      }
    },
    close,
  };
}

export function handleDesktopAudioUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const resource = new URL(req.url ?? "/", "http://127.0.0.1");
  if (resource.pathname !== DESKTOP_AUDIO_PATH) {
    return false;
  }
  const entry = tickets.consume(resource.searchParams.get("token") ?? "");
  if (!entry || !entry.isCurrent()) {
    entry?.close();
    rejectWebSocketUpgrade(socket, { status: 401 });
    return true;
  }
  audioWss.handleUpgrade(req, socket, head, (ws) => entry.attach(ws));
  return true;
}
