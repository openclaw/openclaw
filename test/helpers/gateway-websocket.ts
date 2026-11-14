import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { WebSocket, type RawData } from "ws";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

/** Termination owns errors until the actual close event, including during HTTP upgrade. */
export async function closeGatewayTestWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    // ws aborts CONNECTING with error before close. events.once(close) would
    // reject on that error and release ownership before the close event.
    const onError = () => {};
    const onClose = () => {
      cleanup();
      resolve();
    };
    ws.on("error", onError);
    ws.once("close", onClose);
    try {
      ws.terminate();
    } catch (error) {
      cleanup();
      reject(toErrorObject(error, "Gateway WebSocket termination failed"));
    }
  });
}

/** Callers install nonce observation before handing acquisition ownership here. */
export async function acquireGatewayTestWebSocket(
  ws: WebSocket,
  timeoutMs: number,
  authenticate?: (ws: WebSocket) => Promise<unknown>,
): Promise<WebSocket> {
  let cleanup = () => {};
  let failure: Error | undefined;
  // Event callbacks own this value; each phase boundary must read the current failure.
  const throwIfAcquisitionFailed = () => {
    if (failure) {
      throw failure;
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        clearTimeout(timer);
        resolve();
      };
      const onError = (error: Error) => {
        failure ??= error;
        reject(error);
      };
      const onClose = (code: number, reason: Buffer) =>
        onError(
          new Error(`gateway websocket closed during acquisition (${code}: ${reason.toString()})`),
        );
      const timer = setTimeout(() => onError(new Error("timeout waiting for ws open")), timeoutMs);
      cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      ws.once("open", onOpen);
      ws.on("error", onError);
      ws.once("close", onClose);
    });
    // A received batch can open and fail before authentication may start.
    throwIfAcquisitionFailed();
    if (authenticate) {
      // Keep preparation owned through settlement; racing an error would abandon its writes.
      await authenticate(ws);
    }
    throwIfAcquisitionFailed();
    return ws;
  } catch (error) {
    await runQaGatewayFixture(
      async () => {
        throw failure ?? error;
      },
      () => closeGatewayTestWebSocket(ws),
    );
    throw error;
  } finally {
    cleanup();
  }
}

export type GatewayTestMessage = {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: Record<string, unknown> | null;
  seq?: number;
  stateVersion?: Record<string, unknown>;
  [key: string]: unknown;
};

export function onceMessage<T extends GatewayTestMessage = GatewayTestMessage>(
  ws: WebSocket,
  filter: (obj: T) => boolean,
  // Full-suite runs can saturate the event loop (581+ files). Keep this high
  // enough to avoid flaky RPC timeouts, but still fail fast when a response
  // never arrives.
  timeoutMs = 10_000,
): Promise<T> {
  // Keep the wait's caller in the stack when a timer eventually rejects it.
  const timeoutError = new Error("timeout");
  return new Promise<T>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
    }
    function closeHandler(code: number, reason: Buffer) {
      cleanup();
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    }
    function handler(data: RawData) {
      const obj = JSON.parse(rawDataToString(data)) as T;
      if (filter(obj)) {
        cleanup();
        resolve(obj);
      }
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      cleanup();
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}
