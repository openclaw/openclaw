import { EventEmitter } from "node:events";

export function createNativeSocketFixture() {
  const sockets: NativeSocket[] = [];
  const events = new EventEmitter<{ socket: [] }>();
  class NativeSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = 0;
    sent: string[] = [];

    constructor(readonly url: string) {
      super();
      sockets.push(this);
      events.emit("socket");
    }

    open(): void {
      this.readyState = NativeSocket.OPEN;
      this.emit("open");
    }

    send(payload: string): void {
      this.sent.push(payload);
      this.emit("sent", payload);
    }

    /** Await a captured or future outgoing frame without polling the transport. */
    waitForSent(matches: (payload: string) => boolean): Promise<string> {
      const captured = this.sent.find(matches);
      if (captured !== undefined) {
        return Promise.resolve(captured);
      }
      if (this.readyState === NativeSocket.CLOSED) {
        return Promise.reject(new Error("Native socket closed before the expected frame"));
      }
      return new Promise((resolve, reject) => {
        // Subscribe synchronously after inspecting captured frames, so a send cannot
        // cross an asynchronous gap between the snapshot and its event listener.
        const cleanup = () => {
          this.off("sent", onSent);
          this.off("close", onClose);
        };
        const onSent = (payload: string) => {
          if (matches(payload)) {
            cleanup();
            resolve(payload);
          }
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Native socket closed before the expected frame"));
        };
        this.on("sent", onSent);
        this.on("close", onClose);
      });
    }

    close(code = 1000, reason = "closed"): void {
      if (this.readyState === NativeSocket.CLOSED) {
        return;
      }
      this.readyState = NativeSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    serverEvent(event: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(event)), false);
    }
  }
  return { NativeSocket, sockets, events };
}
