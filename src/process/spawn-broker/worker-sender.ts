import { Socket } from "node:net";
import { createBrokerSender, type BrokerPublisher } from "./ipc.js";

type Send = Parameters<typeof createBrokerSender>[0];
type PendingPipe = {
  id: number;
  fd: number;
  written: boolean;
  received: boolean;
  callback: (error: Error | null) => void;
};

/** A receipt keeps Node's internal handle queue empty before inspecting the next socket. */
export function createWorkerSender(send: Send) {
  let pending: PendingPipe | undefined;
  let closed: Error | undefined;
  const finish = (pipe: PendingPipe, error: Error | null) => {
    if (pending !== pipe) {
      return;
    }
    pending = undefined;
    pipe.callback(error);
  };
  const sender = createBrokerSender((message, handle, callback) => {
    if (closed) {
      callback(closed);
      return;
    }
    if (
      !(handle instanceof Socket) ||
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "pipe" ||
      !("id" in message) ||
      typeof message.id !== "number" ||
      !("fd" in message) ||
      typeof message.fd !== "number"
    ) {
      send(message, handle, callback);
      return;
    }
    const pipe = { id: message.id, fd: message.fd, written: false, received: false, callback };
    pending = pipe;
    // Node destroys stdin when its child exits, including while this send waited in the FIFO.
    const stdinClosed = message.fd === 0 && handle.destroyed;
    try {
      send(
        stdinClosed ? { ...message, closed: true } : message,
        stdinClosed ? undefined : handle,
        (error) => {
          if (error) {
            finish(pipe, error);
            return;
          }
          pipe.written = true;
          if (pipe.received) {
            finish(pipe, null);
          }
        },
      );
    } catch (error) {
      pending = undefined;
      throw error;
    }
  });
  return {
    send: sender,
    reserve<T>(run: (publish: BrokerPublisher) => Promise<T>): Promise<T> {
      return sender.reserve(async (publish) => {
        if (closed) {
          throw closed;
        }
        return await run(publish);
      });
    },
    acknowledge(id: number, fd: number) {
      if (!pending || pending.id !== id || pending.fd !== fd) {
        return;
      }
      pending.received = true;
      if (pending.written) {
        finish(pending, null);
      }
    },
    close(error: Error) {
      closed = error;
      if (pending) {
        finish(pending, error);
      }
    },
  };
}
