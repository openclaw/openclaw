import { receiveMessageOnPort, type MessagePort, type Transferable } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runWithMainThreadTask } from "./main-thread-stall.js";
import { nativePortIsOpen } from "./worker-native-port.js";

type TaskPortMessage = { type: "message"; value: unknown } | { type: "messageerror"; error: Error };

/** The task endpoint owns delivery only; its close never proves native execution stopped. */
export class NativeWorkerTaskPort {
  private readonly pending: TaskPortMessage[] = [];
  private started = false;
  private disposed = false;
  private portClosed = false;
  failure?: Error;

  constructor(
    private readonly port: MessagePort,
    private readonly callbacks: {
      message(value: unknown): void;
      messageerror(error: Error): void;
      unavailable(): void;
    },
  ) {
    port.on("message", this.receive);
    port.on("messageerror", this.receiveError);
    port.on("close", this.closed);
    // The native lifetime owner already references admitted work and unfinished cleanup.
    port.unref();
  }

  private readonly receive = (value: unknown) => {
    this.pending.push({ type: "message", value });
    this.drain();
  };

  private readonly receiveError = (error: Error) => {
    this.pending.push({ type: "messageerror", error });
    this.drain();
  };

  private readonly closed = () => {
    this.portClosed = true;
    this.drain();
    this.fail(new Error("Native worker task channel closed"));
  };

  private fail(error: Error): void {
    if (this.disposed || this.failure) {
      return;
    }
    this.failure = error;
    this.callbacks.unavailable();
  }

  start(): void {
    this.started = true;
  }

  /** Startup admission gates data even when the control owner has already failed. */
  drain(): void {
    if (this.disposed || !this.started) {
      return;
    }
    for (;;) {
      const buffered = this.pending.shift();
      if (buffered) {
        if (buffered.type === "message") {
          this.callbacks.message(buffered.value);
        } else {
          this.callbacks.messageerror(buffered.error);
        }
      } else {
        // Node has released the native endpoint before delivering its close event.
        if (this.portClosed || this.failure) {
          return;
        }
        let next: ReturnType<typeof receiveMessageOnPort>;
        try {
          next = runWithMainThreadTask("worker:message-decode", () =>
            receiveMessageOnPort(this.port),
          );
        } catch (error) {
          this.fail(toErrorObject(error, "Native worker task channel observation failed"));
          return;
        }
        if (!next) {
          return;
        }
        this.callbacks.message(next.message);
      }
      // A callback may synchronously join this worker while servicing its successor.
      if (this.disposed) {
        return;
      }
    }
  }

  service(): void {
    this.drain();
    if (this.disposed || this.failure) {
      return;
    }
    if (this.portClosed) {
      this.fail(new Error("Native worker task channel closed"));
      return;
    }
    let open: boolean;
    try {
      open = nativePortIsOpen(this.port);
    } catch (error) {
      this.fail(toErrorObject(error, "Native worker task channel observation failed"));
      return;
    }
    if (!open) {
      this.portClosed = true;
      this.fail(new Error("Native worker task channel closed"));
    }
  }

  assertAvailable(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.disposed || this.portClosed) {
      throw new Error("Native worker task channel is closed");
    }
  }

  postMessage(value: unknown, transferList: readonly Transferable[]): void {
    this.assertAvailable();
    this.port.postMessage(value, [...transferList]);
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pending.length = 0;
    this.port.off("message", this.receive);
    this.port.off("messageerror", this.receiveError);
    this.port.off("close", this.closed);
    this.port.close();
  }
}
