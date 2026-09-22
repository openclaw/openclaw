import type { Socket } from "node:net";
import { SpawnBrokerError } from "./protocol.js";

type HeldPipe = { read: Socket["read"]; resumed: boolean; onResume: () => void };
const readers = new WeakMap<Socket, HeldPipe>();
const holdReadable = () => {};

/** Defer consumption and EOF until the transferred socket is ready for its caller. */
export function holdPipe(socket: Socket): void {
  const held: HeldPipe = {
    read: socket.read.bind(socket),
    resumed: false,
    onResume: () => {
      held.resumed = true;
    },
  };
  readers.set(socket, held);
  socket.on("resume", held.onResume);
  socket.on("readable", holdReadable);
  // Node's exit drain resumes pipes, and its EOF callback calls read(0) even on
  // paused sockets. Gate reads until publication; native buffering stays bounded.
  socket.read = () => null;
}

/** Stop the sender's libuv reader before Node detaches the socket for IPC. */
export function holdPipeForTransfer(socket: Socket): void {
  stopPipeReads(socket);
  holdPipe(socket);
}

/** Restore native stdin's write-only direction after Node's duplex IPC handoff. */
export function restoreStdinPipe(socket: Socket): void {
  const state: unknown = Reflect.get(socket, "_readableState");
  if (
    !state ||
    typeof state !== "object" ||
    ["ended", "endEmitted", "reading"].some((flag) => typeof Reflect.get(state, flag) !== "boolean")
  ) {
    throw new SpawnBrokerError("Spawn broker requires a Node readable state for stdin");
  }
  stopPipeReads(socket);
  // IPC enables reads on every Socket. Match Duplex's readable:false state so
  // an unused stdin read cannot turn early child closure into ECONNRESET.
  Object.assign(state, { readable: false, ended: true, endEmitted: true, reading: false });
}

function stopPipeReads(socket: Socket): void {
  const handle: unknown = Reflect.get(socket, "_handle");
  if (
    !handle ||
    typeof handle !== "object" ||
    !("readStop" in handle) ||
    typeof handle.readStop !== "function" ||
    !("reading" in handle) ||
    typeof handle.reading !== "boolean"
  ) {
    throw new SpawnBrokerError("Spawn broker requires a transferable Node pipe handle");
  }
  // keepOpen:false drops sender read callbacks; received stdin must never read.
  // Socket.pause() alone does not stop libuv. Keep this checked Node dependency
  // confined here so unsupported handles fail before publication.
  if (handle.readStop() !== 0) {
    throw new SpawnBrokerError("Spawn broker could not stop pipe reads");
  }
  handle.reading = false;
}

/** Called after send's callback, when keepOpen:false has detached the native handle. */
export function takePipePrefix(socket: Socket): Buffer {
  const held = readers.get(socket);
  if (!held) {
    throw new Error("Spawn broker pipe was not held for handoff");
  }
  const buffered: unknown = held.read.call(socket, socket.readableLength);
  restoreReader(socket);
  if (buffered === null) {
    return Buffer.alloc(0);
  }
  if (!Buffer.isBuffer(buffered)) {
    throw new Error("Spawn broker pipe must contain bytes");
  }
  return buffered;
}

/** Restore the pre-transfer buffer ahead of bytes read from the received handle. */
export function restorePipePrefix(socket: Socket, prefix: Buffer): void {
  if (prefix.length > 0) {
    socket.unshift(prefix);
  }
}

/** Publish stream data and EOF after the caller's readiness continuation. */
export function releasePipe(socket: Socket): void {
  const held = restoreReader(socket);
  if (!held) {
    return;
  }
  // Removing a readable listener takes effect on nextTick. Preserve consumption
  // requested while held, including async iterators waiting for another notification.
  process.nextTick(() => {
    if (socket.destroyed) {
      return;
    }
    socket.emit("readable");
    if (held.resumed) {
      socket.resume();
    }
  });
}

function restoreReader(socket: Socket): HeldPipe | undefined {
  const held = readers.get(socket);
  if (!held) {
    return undefined;
  }
  socket.read = held.read;
  readers.delete(socket);
  socket.removeListener("resume", held.onResume);
  socket.removeListener("readable", holdReadable);
  return held;
}
