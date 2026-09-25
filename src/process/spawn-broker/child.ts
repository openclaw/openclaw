import { AsyncResource } from "node:async_hooks";
import type { ChildProcess, MessageOptions, SendHandle, Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../../shared/deferred.js";
import { releasePipe } from "./pipe.js";
import {
  serializeBrokerError,
  SpawnBrokerError,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";

type ChildMessage = Exclude<
  BrokerResponse,
  { type: "ready" | "owned" | "pipe" | "pipe-prefix" | "execa-result" }
>;

type Send = (message: BrokerRequest, handle?: SendHandle) => Promise<void>;

/** Native pipes remain native streams; only lifecycle and IPC cross the broker. */
export class BrokerChild extends EventEmitter implements ChildProcess {
  private readonly callbackContext = new AsyncResource("OpenClawSpawnBrokerChild");
  pid: number | undefined;
  stdin: ChildProcess["stdin"] = null;
  stdout: ChildProcess["stdout"] = null;
  stderr: ChildProcess["stderr"] = null;
  connected = false;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  spawnfile: string;
  spawnargs: string[];
  channel: ChildProcess["channel"];
  stdio: ChildProcess["stdio"] = [null, null, null, null, null];
  private readonly opened = createDeferredCore();
  private readonly completion = createDeferredCore();
  private readonly pipes = new Set<Socket>();
  private readonly sends = new Map<number, (error: Error | null) => void>();
  private sendSequence = 0;
  private spawnReceived = false;
  private eventsReleased = false;
  private pendingEventOverflow = false;
  private readonly pendingEvents: Array<() => void> = [];
  private exited = false;
  private closed = false;
  private processNotStarted = false;

  constructor(
    readonly requestId: number,
    argv: string[],
    private readonly transmit: Send,
  ) {
    super();
    this.spawnfile = argv[0]!;
    this.spawnargs = [...argv];
    void this.opened.promise.catch(() => {});
    // Errors remain observable after admission and before caller listeners attach.
    this.on("error", () => {});
  }

  /** Only the admission owner can establish that no native process was started. */
  markNotStarted(): void {
    this.processNotStarted = true;
  }

  get notStarted(): boolean {
    return this.processNotStarted;
  }

  ready(): Promise<void> {
    return this.opened.promise;
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.callbackContext.runInAsyncScope(() => super.emit(event, ...args));
  }

  /** Transport bookkeeping survives disposal of the caller's event listeners. */
  waitForClose(): Promise<void> {
    return this.completion.promise;
  }

  attachPipe(fd: number, socket: Socket): void {
    // IPC creates these sockets in the broker host's context. Callbacks belong
    // to the command's original scope, just like locally spawned stdio.
    socket.emit = this.callbackContext.bind(socket.emit.bind(socket));
    this.stdio[fd] = socket;
    if (fd === 0) {
      this.stdin = socket;
    }
    if (fd === 1) {
      this.stdout = socket;
    }
    if (fd === 2) {
      this.stderr = socket;
    }
    this.pipes.add(socket);
    let acknowledged = false;
    const acknowledge = (error?: Error) => {
      if (acknowledged) {
        return;
      }
      acknowledged = true;
      void this.transmit({
        type: "output-drained",
        id: this.requestId,
        fd,
        error: error ? serializeBrokerError(error) : undefined,
      }).catch(() => {});
    };
    socket.once(fd === 0 ? "finish" : "end", () => acknowledge());
    socket.on("error", acknowledge);
    socket.once("close", () => {
      acknowledge();
      this.pipes.delete(socket);
      this.finishClose();
    });
  }

  receive(message: ChildMessage): void {
    if (message.type === "spawned") {
      if (this.spawnReceived || this.closed) {
        return;
      }
      this.spawnReceived = true;
      this.pid = message.pid;
      this.spawnfile = message.spawnfile;
      this.spawnargs = message.spawnargs;
      this.connected = message.connected;
      this.stdio.splice(message.stdioLength);
      while (this.stdio.length < message.stdioLength) {
        this.stdio.push(null);
      }
      if (this.connected) {
        this.channel = Object.assign(new EventEmitter(), { ref() {}, unref() {} });
      }
      this.opened.resolve();
      setImmediate(() => {
        if (this.closed) {
          return;
        }
        this.emit("spawn");
        // Awaiters of both ready() and the native spawn event must finish their
        // microtask chains before coalesced IPC can publish terminal events.
        setImmediate(() => {
          for (const [fd, pipe] of this.stdio.entries()) {
            if (fd > 0 && pipe instanceof Socket && !pipe.destroyed) {
              releasePipe(pipe);
            }
          }
          this.eventsReleased = true;
          for (const event of this.pendingEvents.splice(0)) {
            event();
          }
        });
      });
      return;
    }
    if (!this.eventsReleased && (this.spawnReceived || message.type !== "error")) {
      this.deferEvent(() => this.emitMessage(message));
      return;
    }
    this.emitMessage(message);
  }

  private deferEvent(event: () => void): void {
    if (this.pendingEventOverflow) {
      return;
    }
    if (this.pendingEvents.length >= 64) {
      this.pendingEventOverflow = true;
      this.pendingEvents.splice(0);
      this.pendingEvents.push(() => {
        this.kill("SIGKILL");
        this.failNow(new SpawnBrokerError("Spawn broker startup event capacity exceeded"));
      });
      return;
    }
    this.pendingEvents.push(event);
  }

  private emitMessage(message: Exclude<ChildMessage, { type: "spawned" }>): void {
    switch (message.type) {
      case "error": {
        const error = Object.assign(new Error(message.error.message), message.error);
        this.opened.reject(error);
        this.emit("error", error);
        if (!this.pid) {
          this.exited = true;
          this.finishClose();
        }
        break;
      }
      case "exit":
        this.exited = true;
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.stdin?.destroy();
        this.emit("exit", message.code, message.signal);
        process.nextTick(() => {
          for (const pipe of this.pipes) {
            if (pipe.readable) {
              pipe.resume();
            }
          }
        });
        this.finishClose();
        break;
      case "ipc-sent":
        this.finishSend(
          message.sequence,
          message.error ? Object.assign(new Error(message.error.message), message.error) : null,
        );
        break;
      case "disconnect":
        this.failSends(new Error("Child process IPC channel is closed"));
        this.connected = false;
        this.channel = undefined;
        this.emit("disconnect");
        break;
      case "ipc":
        this.emit("message", message.message);
        break;
      case "closed":
        this.finishClose();
        break;
    }
  }

  fail(error: Error): void {
    if (this.spawnReceived && !this.eventsReleased) {
      this.deferEvent(() => this.failNow(error));
      return;
    }
    this.failNow(error);
  }

  private failNow(error: Error): void {
    if (this.closed) {
      return;
    }
    this.opened.reject(error);
    this.failSends(error);
    const wasConnected = this.connected;
    this.connected = false;
    this.channel = undefined;
    if (wasConnected) {
      this.emit("disconnect");
    }
    // Broker loss cannot revoke a direct child's already observed exit outcome.
    if (!this.exited) {
      this.emit("error", error);
    }
    for (const pipe of this.pipes) {
      pipe.destroy(error);
    }
    this.exited = true;
    this.finishClose();
  }

  private finishClose(): void {
    if (!this.exited || this.pipes.size > 0 || this.closed) {
      return;
    }
    this.closed = true;
    this.completion.resolve();
    this.emit("close", this.exitCode, this.signalCode);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exited) {
      return false;
    }
    this.killed = true;
    void this.transmit({ type: "kill", id: this.requestId, signal }).catch((error: unknown) =>
      this.fail(toErrorObject(error, "Spawn broker signal delivery failed")),
    );
    return true;
  }

  send(
    message: Serializable,
    handleOrCallback?: SendHandle | ((error: Error | null) => void),
    optionsOrCallback?: MessageOptions | ((error: Error | null) => void),
    callback?: (error: Error | null) => void,
  ): boolean {
    const done =
      typeof handleOrCallback === "function"
        ? handleOrCallback
        : typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : callback;
    if (!this.connected) {
      const error = new Error("Child process IPC channel is closed");
      queueMicrotask(() => (done ? done(error) : this.emit("error", error)));
      return false;
    }
    if (this.sends.size >= 1024) {
      const error = new Error("Child process IPC capacity exceeded");
      queueMicrotask(() => (done ? done(error) : this.emit("error", error)));
      return false;
    }
    const sequence = ++this.sendSequence;
    this.sends.set(
      sequence,
      AsyncResource.bind((error: Error | null) => {
        if (done) {
          done(error);
        } else if (error) {
          this.emit("error", error);
        }
      }),
    );
    const handle = typeof handleOrCallback === "function" ? undefined : handleOrCallback;
    void this.transmit({ type: "ipc", id: this.requestId, sequence, message }, handle).catch(
      (error: unknown) =>
        this.finishSend(sequence, toErrorObject(error, "Spawn broker IPC delivery failed")),
    );
    return true;
  }

  private finishSend(sequence: number, error: Error | null): void {
    const callback = this.sends.get(sequence);
    this.sends.delete(sequence);
    callback?.(error);
  }

  private failSends(error: Error): void {
    for (const sequence of this.sends.keys()) {
      this.finishSend(sequence, error);
    }
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    void this.transmit({ type: "disconnect", id: this.requestId }).catch((error: unknown) =>
      this.fail(toErrorObject(error, "Spawn broker disconnect failed")),
    );
  }

  ref(): void {}
  unref(): void {}

  [Symbol.dispose](): void {
    this.kill("SIGTERM");
  }
}
