import { EventEmitter } from "node:events";
import type { NativeWorkerResourcePort } from "../../infra/worker-native-lifecycle.types.js";

type PortEvents = { message: [unknown]; close: []; messageerror: [unknown] };

/** A logical resource port; closing it does not assert anything about a native child. */
export class BrokerResourcePort
  extends EventEmitter<PortEvents>
  implements NativeWorkerResourcePort
{
  private closed = false;

  constructor(private readonly send: (value: unknown) => void) {
    super();
  }

  postMessage(value: unknown): void {
    if (this.closed) {
      throw new Error("Native resource message port is closed");
    }
    this.send(value);
  }

  receive(value: unknown): void {
    if (!this.closed) {
      this.emit("message", value);
    }
  }

  fail(error: unknown): void {
    if (!this.closed) {
      this.emit("messageerror", error);
      this.close();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
}
