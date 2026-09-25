import type net from "node:net";

export class SocketReader {
  private buffered = Buffer.alloc(0);
  private readonly waiters = new Set<() => void>();

  constructor(socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buffered = Buffer.concat([
        this.buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      for (const waiter of this.waiters) {
        waiter();
      }
      this.waiters.clear();
    });
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }
}
