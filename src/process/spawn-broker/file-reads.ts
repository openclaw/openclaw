import { createDeferredCore } from "../../shared/deferred.js";
import { SpawnBrokerError, type BrokerRequest, type BrokerResponse } from "./protocol.js";
import type { BrokerResourceResponse } from "./resource-protocol.js";

type ReadResponse = Extract<BrokerResponse, { type: "file-read-chunk" | "file-read-result" }>;

/** Request state only; the existing broker owns process startup, failure, and shutdown. */
export class BrokerFileReads {
  private readonly pending = new Map<
    number,
    { chunks: Buffer[]; result: ReturnType<typeof createDeferredCore<Buffer>> }
  >();
  private sequence = 0;

  constructor(
    private readonly host: {
      ready(): Promise<void>;
      send(
        message: Extract<BrokerRequest, { type: "read-file" | "cancel-read-file" }>,
      ): Promise<void>;
      canAdmit(): boolean;
    },
  ) {}

  get size(): number {
    return this.pending.size;
  }

  async read(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    await this.host.ready();
    signal?.throwIfAborted();
    if (!this.host.canAdmit()) {
      throw new SpawnBrokerError("Spawn broker cannot admit a raw file read");
    }
    const id = ++this.sequence;
    const result = createDeferredCore<Buffer>();
    this.pending.set(id, { chunks: [], result });
    const abort = () => {
      result.reject(signal?.reason);
      void this.host.send({ type: "cancel-read-file", id }).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    void this.host.send({ type: "read-file", id, filePath }).catch(result.reject);
    try {
      return await result.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(id);
    }
  }

  receive(reply: BrokerResponse | BrokerResourceResponse): reply is ReadResponse {
    if (reply.type !== "file-read-chunk" && reply.type !== "file-read-result") {
      return false;
    }
    const read = this.pending.get(reply.id);
    if (read) {
      if (reply.type === "file-read-chunk") {
        read.chunks.push(reply.bytes);
      } else if (reply.error) {
        read.result.reject(Object.assign(reply.error, { code: reply.code }));
      } else {
        read.result.resolve(Buffer.concat(read.chunks));
      }
    }
    return true;
  }

  fail(error: Error): void {
    for (const read of this.pending.values()) {
      read.result.reject(error);
    }
    this.pending.clear();
  }
}
